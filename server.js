const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zambike-secret-key';

app.use(express.json({ limit: '10mb' }));
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

function calculateDistance(lat1, lng1, lat2, lng2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const VEHICLE_MULTIPLIERS = { bike: 1, car: 2, truck: 3.5 };

async function calculateFare(distanceKm, vehicleType = 'bike') {
    const { rows } = await pool.query('SELECT * FROM fare_settings ORDER BY id DESC LIMIT 1');
    const settings = rows[0];
    const multiplier = VEHICLE_MULTIPLIERS[vehicleType] || 1;
    const fare = (parseFloat(settings.base_fare) + (distanceKm * parseFloat(settings.per_km_rate))) * multiplier;
    const zambikeCut = fare * (parseFloat(settings.zambike_percentage) / 100);
    const riderEarnings = fare - zambikeCut;
    return {
        fare: Math.round(fare * 100) / 100,
        zambikeCut: Math.round(zambikeCut * 100) / 100,
        riderEarnings: Math.round(riderEarnings * 100) / 100
    };
}

async function sendPushNotification(token, title, body) {
    if (!token) return;
    try {
        await fetch('https://exp.host/--/api/v2/push/send', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ to: token, sound: 'default', title, body }),
        });
    } catch(e) {}
}

app.post('/auth/register', async (req, res) => {
    try {
        const { phone, name, role, password, bike_plate, vehicle_type, license_photo } = req.body;
        if (!phone || !name || !role || !password)
            return res.status(400).json({ error: 'All fields required' });
        if (!['passenger', 'rider'].includes(role))
            return res.status(400).json({ error: 'Role must be passenger or rider' });
        if (role === 'rider' && !bike_plate)
            return res.status(400).json({ error: 'Vehicle plate number required for riders' });
        if (role === 'rider' && !license_photo)
            return res.status(400).json({ error: 'ID or license photo required for riders' });

        const existing = await pool.query('SELECT id FROM users WHERE phone = $1', [phone]);
        if (existing.rows.length > 0)
            return res.status(400).json({ error: 'Phone number already registered' });

        const passwordHash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            'INSERT INTO users (phone, name, role, password_hash, bike_plate, vehicle_type, license_photo) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, phone, name, role',
            [phone, name, role, passwordHash, bike_plate || null, role === 'rider' ? (vehicle_type || 'bike') : null, license_photo || null]
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
                    is_approved: user.is_approved, rating: user.rating, vehicle_type: user.vehicle_type }
        });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.post('/user/push-token', authMiddleware, async (req, res) => {
    try {
        const { push_token } = req.body;
        await pool.query('UPDATE users SET push_token=$1 WHERE id=$2', [push_token, req.user.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/user/favorites', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT home_lat, home_lng, home_address, work_lat, work_lng, work_address FROM users WHERE id=$1',
            [req.user.id]
        );
        res.json(rows[0] || {});
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/user/favorites', authMiddleware, async (req, res) => {
    try {
        const { type, lat, lng, address } = req.body;
        if (!['home', 'work'].includes(type)) return res.status(400).json({ error: 'Invalid type' });
        const col = type === 'home' ? ['home_lat', 'home_lng', 'home_address'] : ['work_lat', 'work_lng', 'work_address'];
        await pool.query(
            `UPDATE users SET ${col[0]}=$1, ${col[1]}=$2, ${col[2]}=$3 WHERE id=$4`,
            [lat, lng, address, req.user.id]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/ride/messages/:rideId', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT id, sender_id, sender_role, message, created_at FROM ride_messages WHERE ride_id=$1 ORDER BY created_at ASC LIMIT 200',
            [req.params.rideId]
        );
        res.json({ messages: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/ride/messages/:rideId', authMiddleware, async (req, res) => {
    try {
        const { message } = req.body;
        if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty' });

        const { rows } = await pool.query(
            'INSERT INTO ride_messages (ride_id, sender_id, sender_role, message) VALUES ($1,$2,$3,$4) RETURNING *',
            [req.params.rideId, req.user.id, req.user.role, message.trim()]
        );

        const rideResult = await pool.query('SELECT passenger_id, rider_id FROM rides WHERE id=$1', [req.params.rideId]);
        if (rideResult.rows.length > 0) {
            const ride = rideResult.rows[0];
            const recipientId = req.user.role === 'passenger' ? ride.rider_id : ride.passenger_id;
            if (recipientId) {
                const recipient = await pool.query('SELECT push_token, name FROM users WHERE id=$1', [recipientId]);
                const senderName = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
                sendPushNotification(
                    recipient.rows[0]?.push_token,
                    `Message from ${senderName.rows[0]?.name || 'your ride'}`,
                    message.trim()
                );
            }
        }

        res.json({ success: true, message: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

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

app.get('/rider/nearby-requests', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { lat, lng } = req.query;

        const riderInfo = await pool.query('SELECT vehicle_type FROM users WHERE id=$1', [req.user.id]);
        const myVehicleType = riderInfo.rows[0]?.vehicle_type || 'bike';

        const { rows } = await pool.query(
            `SELECT * FROM (
               SELECT r.*, u.name as passenger_name, u.phone as passenger_phone,
               (6371 * acos(cos(radians($1)) * cos(radians(r.pickup_lat)) *
                cos(radians(r.pickup_lng) - radians($2)) +
                sin(radians($1)) * sin(radians(r.pickup_lat)))) AS calc_distance_km
               FROM rides r JOIN users u ON r.passenger_id = u.id
               WHERE r.status = 'requested' AND r.vehicle_type = $3
               AND (r.scheduled_time IS NULL OR r.scheduled_time <= NOW() + INTERVAL '15 minutes')
             ) sub
             WHERE calc_distance_km < 15
             ORDER BY requested_at ASC`,
            [lat, lng, myVehicleType]
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

        const rider = await pool.query('SELECT name FROM users WHERE id=$1', [req.user.id]);
        const passenger = await pool.query('SELECT push_token FROM users WHERE id=$1', [rows[0].passenger_id]);
        sendPushNotification(
            passenger.rows[0]?.push_token,
            'Rider found!',
            `${rider.rows[0].name} accepted your ride and is on the way.`
        );

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

app.get('/rider/ride-history', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            `SELECT r.id, r.pickup_address, r.dest_address, r.rider_earnings, r.distance_km, r.status,
             r.requested_at, r.completed_at, u.name as passenger_name
             FROM rides r
             LEFT JOIN users u ON r.passenger_id = u.id
             WHERE r.rider_id=$1 AND r.status IN ('completed', 'cancelled')
             ORDER BY r.requested_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json({ rides: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/passenger/request-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { pickup_lat, pickup_lng, pickup_address, dest_lat, dest_lng, dest_address, payment_method, vehicle_type, scheduled_time } = req.body;

        const distanceKm = calculateDistance(pickup_lat, pickup_lng, dest_lat, dest_lng);
        const { fare, zambikeCut, riderEarnings } = await calculateFare(distanceKm, vehicle_type || 'bike');

        const { rows } = await pool.query(
            `INSERT INTO rides (passenger_id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distance_km, fare, zambike_cut,
             rider_earnings, payment_method, vehicle_type, scheduled_time)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
            [req.user.id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distanceKm.toFixed(2),
             fare, zambikeCut, riderEarnings, payment_method, vehicle_type || 'bike', scheduled_time || null]
        );

        const isImmediate = !scheduled_time || new Date(scheduled_time) <= new Date(Date.now() + 15 * 60000);
        if (isImmediate) {
            const nearbyRiders = await pool.query(
                `SELECT push_token FROM users u
                 JOIN rider_locations rl ON u.id = rl.rider_id
                 WHERE u.role='rider' AND u.is_online=true AND u.is_approved=true AND u.is_active=true
                 AND u.vehicle_type=$3
                 AND u.push_token IS NOT NULL
                 AND (6371 * acos(cos(radians($1)) * cos(radians(rl.latitude)) *
                      cos(radians(rl.longitude) - radians($2)) +
                      sin(radians($1)) * sin(radians(rl.latitude)))) < 15`,
                [pickup_lat, pickup_lng, vehicle_type || 'bike']
            );
            nearbyRiders.rows.forEach(r => {
                sendPushNotification(r.push_token, 'New ride nearby!', `Fare: K${fare}`);
            });
        }

        res.json({ success: true, ride: rows[0], fare, distanceKm: distanceKm.toFixed(2) });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/passenger/nearby-riders', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { lat, lng } = req.query;

        const { rows } = await pool.query(
            `SELECT * FROM (
               SELECT u.id, u.name, u.rating, u.total_rides,
               rl.latitude, rl.longitude,
               (6371 * acos(cos(radians($1)) * cos(radians(rl.latitude)) *
                cos(radians(rl.longitude) - radians($2)) +
                sin(radians($1)) * sin(radians(rl.latitude)))) AS calc_distance_km
               FROM users u JOIN rider_locations rl ON u.id = rl.rider_id
               WHERE u.role='rider' AND u.is_online=true AND u.is_approved=true
               AND u.is_active=true
               AND rl.updated_at > NOW() - INTERVAL '2 minutes'
             ) sub
             WHERE calc_distance_km < 10
             ORDER BY calc_distance_km ASC`,
            [lat, lng]
        );
        res.json({ riders: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/passenger/current-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            `SELECT r.*, u.name as rider_name, u.phone as rider_phone, u.bike_plate as rider_bike_plate,
             u.rating as rider_rating, rl.latitude as rider_lat, rl.longitude as rider_lng
             FROM rides r
             LEFT JOIN users u ON r.rider_id = u.id
             LEFT JOIN rider_locations rl ON r.rider_id = rl.rider_id
             WHERE r.passenger_id=$1 AND r.status NOT IN ('completed','cancelled')
             AND (r.scheduled_time IS NULL OR r.scheduled_time <= NOW() + INTERVAL '15 minutes' OR r.status != 'requested')
             ORDER BY r.requested_at DESC LIMIT 1`,
            [req.user.id]
        );
        res.json({ ride: rows[0] || null });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/passenger/scheduled-rides', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            `SELECT id, pickup_address, dest_address, fare, scheduled_time, vehicle_type
             FROM rides
             WHERE passenger_id=$1 AND status='requested'
             AND scheduled_time IS NOT NULL AND scheduled_time > NOW() + INTERVAL '15 minutes'
             ORDER BY scheduled_time ASC`,
            [req.user.id]
        );
        res.json({ rides: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/passenger/ride-history', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            `SELECT r.id, r.pickup_address, r.dest_address, r.fare, r.distance_km, r.status,
             r.requested_at, r.completed_at, u.name as rider_name
             FROM rides r
             LEFT JOIN users u ON r.rider_id = u.id
             WHERE r.passenger_id=$1 AND r.status IN ('completed', 'cancelled')
             ORDER BY r.requested_at DESC LIMIT 50`,
            [req.user.id]
        );
        res.json({ rides: rows });
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

app.post('/fare-estimate', async (req, res) => {
    try {
        const { pickup_lat, pickup_lng, dest_lat, dest_lng, vehicle_type } = req.body;
        const distanceKm = calculateDistance(pickup_lat, pickup_lng, dest_lat, dest_lng);
        const { fare, zambikeCut, riderEarnings } = await calculateFare(distanceKm, vehicle_type || 'bike');
        res.json({ fare, distanceKm: distanceKm.toFixed(2), riderEarnings, zambikeCut });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

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
            `SELECT id, phone, name, is_approved, is_online, is_active, rating, total_rides, created_at, vehicle_type, bike_plate,
             (license_photo IS NOT NULL) as has_license_photo
             FROM users WHERE role='rider' ORDER BY created_at DESC`
        );
        res.json({ riders: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/rider-license/:userId', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query('SELECT license_photo FROM users WHERE id=$1', [req.params.userId]);
        if (rows.length === 0 || !rows[0].license_photo) return res.status(404).json({ error: 'No photo on file' });
        res.json({ license_photo: rows[0].license_photo });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/active-rides', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query(
            `SELECT r.id, r.passenger_id, r.rider_id, r.status, r.requested_at, u.name as passenger_name, u.phone as passenger_phone
             FROM rides r JOIN users u ON r.passenger_id = u.id
             WHERE r.status NOT IN ('completed', 'cancelled')
             ORDER BY r.requested_at DESC`
        );
        res.json({ rides: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/force-cancel-ride/:rideId', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        await pool.query(
            `UPDATE rides SET status='cancelled', cancelled_at=NOW(), cancel_reason='admin force-cancel' WHERE id=$1`,
            [req.params.rideId]
        );
        res.json({ success: true });
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
