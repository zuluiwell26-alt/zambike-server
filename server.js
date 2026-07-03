const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zambike-secret-key';

app.use(express.json());
app.use(express.static('public'));
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ── MIDDLEWARE ─────────────────────────────────────────────────
function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        req.user = jwt.verify(token, JWT_SECRET);
        next();
    } catch(e) {
        res.status(401).json({ error: 'Invalid token' });
    }
}

function pad(n) { return String(n).padStart(2, '0'); }

// ── HELPERS ────────────────────────────────────────────────────
function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

async function calculateFare(distanceKm) {
    const { rows } = await pool.query('SELECT * FROM fare_settings ORDER BY id DESC LIMIT 1');
    const settings = rows[0];
    const fare = parseFloat(settings.base_fare) + (distanceKm * parseFloat(settings.per_km_rate));
    const zambikeCut = fare * (parseFloat(settings.zambike_percentage) / 100);
    const riderEarnings = fare - zambikeCut;
    return {
        fare: Math.round(fare * 100) / 100,
        zambikeCut: Math.round(zambikeCut * 100) / 100,
        riderEarnings: Math.round(riderEarnings * 100) / 100
    };
}

// ── AUTH ENDPOINTS ─────────────────────────────────────────────

app.post('/auth/register', async (req, res) => {
    try {
        const { phone, name, role, password } = req.body;
        if (!phone || !name || !role || !password)
            return res.status(400).json({ error: 'All fields required' });
        if (!['passenger', 'rider'].includes(role))
            return res.status(400).json({ error: 'Role must be passenger or rider' });

        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (existing.rows.length > 0)
            return res.status(400).json({ error: 'Phone number already registered' });

        const passwordHash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            'INSERT INTO users (phone, name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id, phone, name, role',
            [phone, name, role, passwordHash]
        );
        const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, user: rows[0], token });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/auth/login', async (req, res) => {
    try {
        const { phone, password } = req.body;
        const { rows } = await pool.query('SELECT * FROM users WHERE phone = $1', [phone]);
        if (rows.length === 0) return res.status(400).json({ error: 'Phone number not found' });

        const user = rows[0];
        const valid = await bcrypt.compare(password, user.password_hash);
        if (!valid) return res.status(400).json({ error: 'Wrong password' });
        if (!user.is_active) return res.status(400).json({ error: 'Account suspended' });

        const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({
            success: true,
            token,
            user: { id: user.id, phone: user.phone, name: user.name, role: user.role,
                    is_approved: user.is_approved, rating: user.rating }
        });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

// ── RIDER ENDPOINTS ────────────────────────────────────────────

app.post('/rider/location', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { latitude, longitude } = req.body;
        await pool.query(
            `INSERT INTO rider_locations (rider_id, latitude, longitude, updated_at)
             VALUES ($1, $2, $3, NOW())
             ON CONFLICT (rider_id) DO UPDATE SET latitude=$2, longitude=$3, updated_at=NOW()`,
            [req.user.id, latitude, longitude]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/rider/status', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { is_online } = req.body;
        await pool.query('UPDATE users SET is_online=$1 WHERE id=$2', [is_online, req.user.id]);
        res.json({ success: true, is_online });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/rider/current-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            `SELECT r.*, u.name as passenger_name, u.phone as passenger_phone
             FROM rides r JOIN users u ON r.passenger_id = u.id
             WHERE r.rider_id = $1 AND r.status IN ('accepted','arriving','in_progress')
             ORDER BY r.requested_at DESC LIMIT 1`,
            [req.user.id]
        );
        res.json({ ride: rows[0] || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// Get nearby ride requests (for riders)
app.get('/rider/nearby-requests', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { lat, lng } = req.query;

        const { rows } = await pool.query(
            `SELECT r.*, u.name as passenger_name, u.phone as passenger_phone,
             (6371 * acos(cos(radians($1)) * cos(radians(r.pickup_lat)) *
              cos(radians(r.pickup_lng) - radians($2)) +
              sin(radians($1)) * sin(radians(r.pickup_lat)))) AS distance_km
             FROM rides r JOIN users u ON r.passenger_id = u.id
             WHERE r.status = 'requested'
             HAVING (6371 * acos(cos(radians($1)) * cos(radians(r.pickup_lat)) *
              cos(radians(r.pickup_lng) - radians($2)) +
              sin(radians($1)) * sin(radians(r.pickup_lat)))) < 15
             ORDER BY r.requested_at ASC`,
            [lat, lng]
        );
        res.json({ rides: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/rider/accept-ride/:rideId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            `UPDATE rides SET rider_id=$1, status='accepted', accepted_at=NOW()
             WHERE id=$2 AND status='requested' RETURNING *`,
            [req.user.id, req.params.rideId]
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Ride no longer available' });
        res.json({ success: true, ride: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/rider/update-ride/:rideId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { status } = req.body;
        const validStatuses = ['arriving', 'in_progress', 'completed'];
        if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Invalid status' });

        let extra = '';
        if (status === 'in_progress') extra = ', started_at=NOW()';
        if (status === 'completed') extra = ', completed_at=NOW()';

        const { rows } = await pool.query(
            `UPDATE rides SET status=$1 ${extra} WHERE id=$2 AND rider_id=$3 RETURNING *`,
            [status, req.params.rideId, req.user.id]
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Ride not found' });

        if (status === 'completed') {
            await pool.query(
                'UPDATE users SET total_rides=total_rides+1, total_earnings=total_earnings+$1 WHERE id=$2',
                [rows[0].rider_earnings, req.user.id]
            );
            await pool.query('UPDATE users SET total_trips=total_trips+1 WHERE id=$1', [rows[0].passenger_id]);
        }
        res.json({ success: true, ride: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/rider/earnings', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            `SELECT COUNT(*) as total_rides, SUM(rider_earnings) as total_earned,
             SUM(CASE WHEN completed_at::date = CURRENT_DATE THEN rider_earnings ELSE 0 END) as today_earned
             FROM rides WHERE rider_id=$1 AND status='completed'`,
            [req.user.id]
        );
        res.json(rows[0]);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── PASSENGER ENDPOINTS ────────────────────────────────────────

app.post('/passenger/request-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { pickup_lat, pickup_lng, pickup_address, dest_lat, dest_lng, dest_address, payment_method } = req.body;

        const distanceKm = calculateDistance(pickup_lat, pickup_lng, dest_lat, dest_lng);
        const { fare, zambikeCut, riderEarnings } = await calculateFare(distanceKm);

        const { rows } = await pool.query(
            `INSERT INTO rides (passenger_id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distance_km, fare, zambike_cut,
             rider_earnings, payment_method)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
            [req.user.id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distanceKm.toFixed(2),
             fare, zambikeCut, riderEarnings, payment_method]
        );

        res.json({ success: true, ride: rows[0], fare, distanceKm: distanceKm.toFixed(2) });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/passenger/nearby-riders', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { lat, lng } = req.query;

        const { rows } = await pool.query(
            `SELECT u.id, u.name, u.rating, u.total_rides,
             rl.latitude, rl.longitude,
             (6371 * acos(cos(radians($1)) * cos(radians(rl.latitude)) *
              cos(radians(rl.longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(rl.latitude)))) AS distance_km
             FROM users u JOIN rider_locations rl ON u.id = rl.rider_id
             WHERE u.role='rider' AND u.is_online=true AND u.is_approved=true
             AND u.is_active=true
             AND rl.updated_at > NOW() - INTERVAL '2 minutes'
             HAVING (6371 * acos(cos(radians($1)) * cos(radians(rl.latitude)) *
              cos(radians(rl.longitude) - radians($2)) +
              sin(radians($1)) * sin(radians(rl.latitude)))) < 10
             ORDER BY distance_km ASC`,
            [lat, lng]
        );
        res.json({ riders: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/passenger/current-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            `SELECT r.*, u.name as rider_name, u.phone as rider_phone,
             u.rating as rider_rating, rl.latitude as rider_lat, rl.longitude as rider_lng
             FROM rides r
             LEFT JOIN users u ON r.rider_id = u.id
             LEFT JOIN rider_locations rl ON r.rider_id = rl.rider_id
             WHERE r.passenger_id=$1 AND r.status NOT IN ('completed','cancelled')
             ORDER BY r.requested_at DESC LIMIT 1`,
            [req.user.id]
        );
        res.json({ ride: rows[0] || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/passenger/cancel-ride/:rideId', authMiddleware, async (req, res) => {
    try {
        const { reason } = req.body;
        const { rows } = await pool.query(
            `UPDATE rides SET status='cancelled', cancelled_at=NOW(), cancel_reason=$1
             WHERE id=$2 AND passenger_id=$3 AND status IN ('requested','accepted')
             RETURNING *`,
            [reason || 'Cancelled by passenger', req.params.rideId, req.user.id]
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Cannot cancel this ride' });
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/ride/rate/:rideId', authMiddleware, async (req, res) => {
    try {
        const { stars, comment } = req.body;
        const { rows: rideRows } = await pool.query('SELECT * FROM rides WHERE id=$1', [req.params.rideId]);
        if (rideRows.length === 0) return res.status(404).json({ error: 'Ride not found' });
        const ride = rideRows[0];

        const ratedUser = req.user.role === 'passenger' ? ride.rider_id : ride.passenger_id;

        await pool.query(
            'INSERT INTO ratings (ride_id, rated_by, rated_user, stars, comment) VALUES ($1,$2,$3,$4,$5)',
            [ride.id, req.user.id, ratedUser, stars, comment]
        );

        const { rows: avgRows } = await pool.query(
            'SELECT AVG(stars) as avg FROM ratings WHERE rated_user=$1', [ratedUser]
        );
        await pool.query('UPDATE users SET rating=$1 WHERE id=$2', [avgRows[0].avg, ratedUser]);

        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── FARE ESTIMATE ──────────────────────────────────────────────
app.post('/fare-estimate', async (req, res) => {
    try {
        const { pickup_lat, pickup_lng, dest_lat, dest_lng } = req.body;
        const distanceKm = calculateDistance(pickup_lat, pickup_lng, dest_lat, dest_lng);
        const { fare, zambikeCut, riderEarnings } = await calculateFare(distanceKm);
        res.json({ fare, distanceKm: distanceKm.toFixed(2), riderEarnings, zambikeCut });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── ADMIN ENDPOINTS ────────────────────────────────────────────

app.post('/admin/approve-rider/:userId', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        await pool.query('UPDATE users SET is_approved=true WHERE id=$1 AND role=$2', [req.params.userId, 'rider']);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/suspend-user/:userId', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        await pool.query('UPDATE users SET is_active=false WHERE id=$1', [req.params.userId]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/riders', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query(
            `SELECT id, phone, name, is_approved, is_online, is_active, rating, total_rides, created_at
             FROM users WHERE role='rider' ORDER BY created_at DESC`
        );
        res.json({ riders: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/stats', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });

        const [riders, passengers, rides, earnings] = await Promise.all([
            pool.query("SELECT COUNT(*) FROM users WHERE role='rider'"),
            pool.query("SELECT COUNT(*) FROM users WHERE role='passenger'"),
            pool.query("SELECT COUNT(*) FROM rides WHERE status='completed'"),
            pool.query("SELECT SUM(zambike_cut) as total FROM rides WHERE status='completed'")
        ]);

        res.json({
            total_riders: riders.rows[0].count,
            total_passengers: passengers.rows[0].count,
            total_rides: rides.rows[0].count,
            total_earnings: earnings.rows[0].total || 0
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/fare-settings', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { base_fare, per_km_rate, zambike_percentage } = req.body;
        await pool.query(
            'INSERT INTO fare_settings (base_fare, per_km_rate, zambike_percentage) VALUES ($1,$2,$3)',
            [base_fare, per_km_rate, zambike_percentage]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── INIT ───────────────────────────────────────────────────────
async function initDB() {
    const fs = require('fs');
    const schema = fs.readFileSync('./schema.sql', 'utf8');
    await pool.query(schema);
    console.log('Database ready');
}

initDB().then(() => {
    app.listen(PORT, () => console.log(`Zambike server running on port ${PORT}`));
}).catch(err => {
    console.error('DB init failed:', err);
    process.exit(1);
});
