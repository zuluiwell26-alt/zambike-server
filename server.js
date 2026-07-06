const express = require('express');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'zambike-secret-key';
const MONEYUNIFY_AUTH_ID = process.env.MONEYUNIFY_AUTH_ID;

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

function calculateTotalRouteDistance(pickup, stops, destination) {
    let total = 0;
    let prev = pickup;
    for (const stop of stops) {
        total += calculateDistance(prev.lat, prev.lng, stop.lat, stop.lng);
        prev = stop;
    }
    total += calculateDistance(prev.lat, prev.lng, destination.lat, destination.lng);
    return total;
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

function generateReferralCode(name, id) {
    const clean = (name || 'ZED').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 4) || 'ZED';
    return clean + id;
}

async function checkAndGrantReferrerReward(userId) {
    try {
        const userResult = await pool.query('SELECT referred_by, referral_reward_granted FROM users WHERE id=$1', [userId]);
        const user = userResult.rows[0];
        if (!user || !user.referred_by || user.referral_reward_granted) return;

        const referrerResult = await pool.query('SELECT id, role, push_token, name FROM users WHERE id=$1', [user.referred_by]);
        const referrer = referrerResult.rows[0];
        if (!referrer) return;

        if (referrer.role === 'rider') {
            await pool.query('UPDATE users SET commission_free_rides_remaining = commission_free_rides_remaining + 3 WHERE id=$1', [referrer.id]);
            sendPushNotification(referrer.push_token, 'Referral bonus unlocked!', 'Your friend completed their first ride. You earned 3 commission-free rides!');
        } else {
            await pool.query('UPDATE users SET discount_rides_remaining = discount_rides_remaining + 1, discount_rides_percent = 15 WHERE id=$1', [referrer.id]);
            sendPushNotification(referrer.push_token, 'Referral bonus unlocked!', 'Your friend completed their first ride. You earned 15% off your next ride!');
        }

        await pool.query('UPDATE users SET referral_reward_granted=true WHERE id=$1', [userId]);
    } catch(e) { console.error('Referral reward error:', e); }
}

function normalizePhoneForPayment(phone) {
    let cleaned = (phone || '').replace(/\s+/g, '').replace(/[^\d+]/g, '');
    if (cleaned.startsWith('+260')) cleaned = '0' + cleaned.slice(4);
    else if (cleaned.startsWith('260')) cleaned = '0' + cleaned.slice(3);
    else if (!cleaned.startsWith('0')) cleaned = '0' + cleaned;
    return cleaned;
}

async function initiateMoneyUnifyPayment(phone, amount) {
    try {
        const params = new URLSearchParams({
            from_payer: normalizePhoneForPayment(phone),
            amount: String(amount),
            auth_id: MONEYUNIFY_AUTH_ID,
        });
        const res = await fetch('https://api.moneyunify.one/payments/request', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: params.toString(),
        });
        const data = await res.json();
        return data;
    } catch(e) {
        return { isError: true, message: e.message };
    }
}

async function verifyMoneyUnifyPayment(transactionId) {
    try {
        const params = new URLSearchParams({
            transaction_id: transactionId,
            auth_id: MONEYUNIFY_AUTH_ID,
        });
        const res = await fetch('https://api.moneyunify.one/payments/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
            body: params.toString(),
        });
        const data = await res.json();
        return data;
    } catch(e) {
        return { isError: true, message: e.message };
    }
}

app.post('/auth/register', async (req, res) => {
    try {
        const { phone, name, role, password, bike_plate, vehicle_type, license_photo, referral_code } = req.body;
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

        let referrerId = null;
        if (referral_code) {
            const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code.trim().toUpperCase()]);
            if (referrer.rows.length === 0) {
                return res.status(400).json({ error: 'Invalid referral code' });
            }
            referrerId = referrer.rows[0].id;
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const { rows } = await pool.query(
            `INSERT INTO users (phone, name, role, password_hash, bike_plate, vehicle_type, license_photo, referred_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, phone, name, role`,
            [phone, name, role, passwordHash, bike_plate || null, role === 'rider' ? (vehicle_type || 'bike') : null,
             license_photo || null, referrerId]
        );

        const newUserId = rows[0].id;
        const myReferralCode = generateReferralCode(name, newUserId);
        await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [myReferralCode, newUserId]);

        const token = jwt.sign({ id: rows[0].id, role: rows[0].role }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, user: { ...rows[0], referral_code: myReferralCode }, token });
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
                    is_approved: user.is_approved, rating: user.rating, vehicle_type: user.vehicle_type,
                    referral_code: user.referral_code }
        });
    } catch(e) { console.error(e); res.status(500).json({ error: e.message }); }
});

app.get('/user/referral-info', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            `SELECT id, name, referral_code, referred_by, new_signup_discount_used,
             commission_free_rides_remaining, discount_rides_remaining, discount_rides_percent
             FROM users WHERE id=$1`,
            [req.user.id]
        );
        let info = rows[0] || {};

        if (!info.referral_code) {
            const newCode = generateReferralCode(info.name, info.id);
            await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [newCode, info.id]);
            info.referral_code = newCode;
        }

        info.new_signup_discount_available = !!(info.referred_by && !info.new_signup_discount_used);
        res.json(info);
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/promo/validate', authMiddleware, async (req, res) => {
    try {
        const { code, fare } = req.body;
        if (!code) return res.status(400).json({ error: 'No code provided' });

        const { rows } = await pool.query(
            'SELECT * FROM promo_codes WHERE code=$1 AND is_active=true',
            [code.trim().toUpperCase()]
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Invalid or expired promo code' });

        const promo = rows[0];
        if (promo.expires_at && new Date(promo.expires_at) < new Date())
            return res.status(400).json({ error: 'This promo code has expired' });
        if (promo.max_uses && promo.uses_count >= promo.max_uses)
            return res.status(400).json({ error: 'This promo code has reached its usage limit' });

        let discount = promo.discount_type === 'percent'
            ? fare * (parseFloat(promo.discount_value) / 100)
            : parseFloat(promo.discount_value);
        discount = Math.min(discount, fare);

        res.json({
            valid: true,
            discount: Math.round(discount * 100) / 100,
            newFare: Math.round((fare - discount) * 100) / 100,
        });
    } catch(e) { res.status(500).json({ error: e.message }); }
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

app.get('/ride/stops/:rideId', authMiddleware, async (req, res) => {
    try {
        const { rows } = await pool.query(
            'SELECT * FROM ride_stops WHERE ride_id=$1 ORDER BY seq ASC',
            [req.params.rideId]
        );
        res.json({ stops: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/ride/stops/:stopId/reached', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            'UPDATE ride_stops SET reached_at=NOW() WHERE id=$1 RETURNING *',
            [req.params.stopId]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Stop not found' });
        res.json({ success: true, stop: rows[0] });
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

        if (status === 'completed') {
            const unreached = await pool.query(
                'SELECT id FROM ride_stops WHERE ride_id=$1 AND reached_at IS NULL',
                [req.params.rideId]
            );
            if (unreached.rows.length > 0) {
                return res.status(400).json({ error: 'Please mark all stops as reached before completing the ride' });
            }
        }

        let extra = '';
        if (status === 'in_progress') extra = ', started_at=NOW()';
        if (status === 'completed') extra = ', completed_at=NOW()';

        const { rows } = await pool.query(
            `UPDATE rides SET status=$1 ${extra} WHERE id=$2 AND rider_id=$3 RETURNING *`,
            [status, req.params.rideId, req.user.id]
        );
        if (rows.length === 0) return res.status(400).json({ error: 'Ride not found' });

        let ride = rows[0];

        if (status === 'completed') {
            const riderBefore = await pool.query('SELECT total_rides, commission_free_rides_remaining FROM users WHERE id=$1', [req.user.id]);
            const passengerBefore = await pool.query('SELECT total_trips, phone FROM users WHERE id=$1', [ride.passenger_id]);

            let finalZambikeCut = ride.zambike_cut;
            let finalRiderEarnings = ride.rider_earnings;
            const commissionFreeLeft = riderBefore.rows[0]?.commission_free_rides_remaining || 0;

            if (commissionFreeLeft > 0) {
                finalZambikeCut = 0;
                finalRiderEarnings = ride.fare;
                await pool.query('UPDATE users SET commission_free_rides_remaining = commission_free_rides_remaining - 1 WHERE id=$1', [req.user.id]);
                await pool.query('UPDATE rides SET zambike_cut=$1, rider_earnings=$2, used_commission_free=true WHERE id=$3', [finalZambikeCut, finalRiderEarnings, ride.id]);
                ride.zambike_cut = finalZambikeCut;
                ride.rider_earnings = finalRiderEarnings;
            }

            await pool.query(
                'UPDATE users SET total_rides=total_rides+1, total_earnings=total_earnings+$1, wallet_balance=wallet_balance+$1 WHERE id=$2',
                [finalRiderEarnings, req.user.id]
            );
            await pool.query('UPDATE users SET total_trips=total_trips+1 WHERE id=$1', [ride.passenger_id]);

            if ((riderBefore.rows[0]?.total_rides || 0) === 0) {
                await checkAndGrantReferrerReward(req.user.id);
            }
            if ((passengerBefore.rows[0]?.total_trips || 0) === 0) {
                await checkAndGrantReferrerReward(ride.passenger_id);
            }

            if (ride.fare > 0 && MONEYUNIFY_AUTH_ID) {
                const passengerPhone = passengerBefore.rows[0]?.phone;
                const paymentResult = await initiateMoneyUnifyPayment(passengerPhone, ride.fare);
                if (!paymentResult.isError && paymentResult.data?.transaction_id) {
                    await pool.query(
                        'UPDATE rides SET payment_reference=$1, payment_status=$2 WHERE id=$3',
                        [paymentResult.data.transaction_id, 'pending', ride.id]
                    );
                    ride.payment_reference = paymentResult.data.transaction_id;
                    ride.payment_status = 'pending';
                } else {
                    await pool.query('UPDATE rides SET payment_status=$1 WHERE id=$2', ['failed', ride.id]);
                    ride.payment_status = 'failed';
                }
            }
        }

        res.json({ success: true, ride });
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

app.get('/rider/wallet', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [req.user.id]);
        res.json({ balance: rows[0]?.wallet_balance || 0 });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/rider/withdraw', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { amount, phone_number, network } = req.body;
        if (!amount || amount <= 0) return res.status(400).json({ error: 'Invalid amount' });
        if (!phone_number || !network) return res.status(400).json({ error: 'Phone number and network required' });

        const userResult = await pool.query('SELECT wallet_balance FROM users WHERE id=$1', [req.user.id]);
        const balance = parseFloat(userResult.rows[0]?.wallet_balance || 0);
        if (amount > balance) return res.status(400).json({ error: 'Amount exceeds your wallet balance' });

        await pool.query('UPDATE users SET wallet_balance = wallet_balance - $1 WHERE id=$2', [amount, req.user.id]);
        const { rows } = await pool.query(
            `INSERT INTO withdrawal_requests (rider_id, amount, phone_number, network) VALUES ($1,$2,$3,$4) RETURNING *`,
            [req.user.id, amount, phone_number, network]
        );

        res.json({ success: true, request: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/rider/withdrawal-history', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'rider') return res.status(403).json({ error: 'Riders only' });
        const { rows } = await pool.query(
            'SELECT * FROM withdrawal_requests WHERE rider_id=$1 ORDER BY requested_at DESC LIMIT 30',
            [req.user.id]
        );
        res.json({ requests: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/passenger/request-ride', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { pickup_lat, pickup_lng, pickup_address, dest_lat, dest_lng, dest_address, payment_method, vehicle_type, scheduled_time, promo_code, stops } = req.body;

        const stopsList = Array.isArray(stops) ? stops.slice(0, 2) : [];
        const distanceKm = calculateTotalRouteDistance(
            { lat: pickup_lat, lng: pickup_lng },
            stopsList.map(s => ({ lat: s.lat, lng: s.lng })),
            { lat: dest_lat, lng: dest_lng }
        );
        const { fare: baseFare, zambikeCut: baseCut } = await calculateFare(distanceKm, vehicle_type || 'bike');

        let finalFare = baseFare;
        let discountAmount = 0;
        let appliedLabel = null;
        let consumeDiscountRide = false;
        let consumeNewSignupDiscount = false;

        const userInfo = await pool.query(
            'SELECT discount_rides_remaining, discount_rides_percent, referred_by, new_signup_discount_used FROM users WHERE id=$1',
            [req.user.id]
        );
        const u = userInfo.rows[0] || {};

        if (u.discount_rides_remaining > 0 && u.discount_rides_percent > 0) {
            const discount = Math.min(baseFare * (parseFloat(u.discount_rides_percent) / 100), baseFare);
            discountAmount = Math.round(discount * 100) / 100;
            finalFare = Math.round((baseFare - discount) * 100) / 100;
            appliedLabel = 'REFERRAL_BONUS';
            consumeDiscountRide = true;
        } else if (u.referred_by && !u.new_signup_discount_used) {
            const discount = Math.min(baseFare * 0.05, baseFare);
            discountAmount = Math.round(discount * 100) / 100;
            finalFare = Math.round((baseFare - discount) * 100) / 100;
            appliedLabel = 'NEW_MEMBER_5';
            consumeNewSignupDiscount = true;
        } else if (promo_code) {
            const promoResult = await pool.query(
                'SELECT * FROM promo_codes WHERE code=$1 AND is_active=true',
                [promo_code.trim().toUpperCase()]
            );
            if (promoResult.rows.length > 0) {
                const promo = promoResult.rows[0];
                const notExpired = !promo.expires_at || new Date(promo.expires_at) >= new Date();
                const underLimit = !promo.max_uses || promo.uses_count < promo.max_uses;
                if (notExpired && underLimit) {
                    let discount = promo.discount_type === 'percent'
                        ? baseFare * (parseFloat(promo.discount_value) / 100)
                        : parseFloat(promo.discount_value);
                    discount = Math.min(discount, baseFare);
                    discountAmount = Math.round(discount * 100) / 100;
                    finalFare = Math.round((baseFare - discount) * 100) / 100;
                    appliedLabel = promo.code;
                    await pool.query('UPDATE promo_codes SET uses_count = uses_count + 1 WHERE id=$1', [promo.id]);
                }
            }
        }

        const proportionalMultiplier = baseFare > 0 ? finalFare / baseFare : 0;
        const finalZambikeCut = Math.round(baseCut * proportionalMultiplier * 100) / 100;
        const finalRiderEarnings = Math.round((finalFare - finalZambikeCut) * 100) / 100;

        const { rows } = await pool.query(
            `INSERT INTO rides (passenger_id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distance_km, fare, zambike_cut,
             rider_earnings, payment_method, vehicle_type, scheduled_time, promo_code, discount_amount, original_fare)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
            [req.user.id, pickup_lat, pickup_lng, pickup_address,
             dest_lat, dest_lng, dest_address, distanceKm.toFixed(2),
             finalFare, finalZambikeCut, finalRiderEarnings, payment_method, vehicle_type || 'bike',
             scheduled_time || null, appliedLabel, discountAmount, baseFare]
        );

        const newRide = rows[0];

        for (let i = 0; i < stopsList.length; i++) {
            await pool.query(
                'INSERT INTO ride_stops (ride_id, seq, lat, lng, address, wait_minutes) VALUES ($1,$2,$3,$4,$5,$6)',
                [newRide.id, i + 1, stopsList[i].lat, stopsList[i].lng, stopsList[i].address || '', stopsList[i].wait_minutes || 0]
            );
        }

        if (consumeDiscountRide) {
            await pool.query('UPDATE users SET discount_rides_remaining = discount_rides_remaining - 1 WHERE id=$1', [req.user.id]);
        }
        if (consumeNewSignupDiscount) {
            await pool.query('UPDATE users SET new_signup_discount_used = true WHERE id=$1', [req.user.id]);
        }

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
                sendPushNotification(r.push_token, 'New ride nearby!', `Fare: K${finalFare}`);
            });
        }

        res.json({ success: true, ride: newRide, fare: finalFare, originalFare: baseFare, discountAmount, appliedLabel, distanceKm: distanceKm.toFixed(2) });
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

app.get('/passenger/last-completed-ride/:rideId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            `SELECT r.*, u.name as rider_name FROM rides r
             LEFT JOIN users u ON r.rider_id = u.id
             WHERE r.id=$1 AND r.passenger_id=$2`,
            [req.params.rideId, req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
        res.json({ ride: rows[0] });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/passenger/payment-status/:rideId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const { rows } = await pool.query(
            'SELECT payment_status, payment_reference, fare FROM rides WHERE id=$1 AND passenger_id=$2',
            [req.params.rideId, req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
        const ride = rows[0];

        if (ride.payment_status === 'pending' && ride.payment_reference) {
            const verifyResult = await verifyMoneyUnifyPayment(ride.payment_reference);
            if (!verifyResult.isError) {
                const remoteStatus = verifyResult.data?.status;
                if (remoteStatus === 'successful' || remoteStatus === 'success') {
                    await pool.query('UPDATE rides SET payment_status=$1 WHERE id=$2', ['paid', req.params.rideId]);
                    ride.payment_status = 'paid';
                } else if (remoteStatus === 'failed' || remoteStatus === 'error') {
                    await pool.query('UPDATE rides SET payment_status=$1 WHERE id=$2', ['failed', req.params.rideId]);
                    ride.payment_status = 'failed';
                }
            }
        }

        res.json({ payment_status: ride.payment_status, fare: ride.fare });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/passenger/retry-payment/:rideId', authMiddleware, async (req, res) => {
    try {
        if (req.user.role !== 'passenger') return res.status(403).json({ error: 'Passengers only' });
        const rideResult = await pool.query('SELECT fare, payment_status FROM rides WHERE id=$1 AND passenger_id=$2', [req.params.rideId, req.user.id]);
        if (rideResult.rows.length === 0) return res.status(404).json({ error: 'Ride not found' });
        const ride = rideResult.rows[0];

        const userResult = await pool.query('SELECT phone FROM users WHERE id=$1', [req.user.id]);
        const phone = userResult.rows[0]?.phone;

        const paymentResult = await initiateMoneyUnifyPayment(phone, ride.fare);
        if (!paymentResult.isError && paymentResult.data?.transaction_id) {
            await pool.query('UPDATE rides SET payment_reference=$1, payment_status=$2 WHERE id=$3', [paymentResult.data.transaction_id, 'pending', req.params.rideId]);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: paymentResult.message || 'Could not initiate payment' });
        }
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
             r.requested_at, r.completed_at, r.payment_status, u.name as rider_name
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
        const { pickup_lat, pickup_lng, dest_lat, dest_lng, vehicle_type, stops } = req.body;
        const stopsList = Array.isArray(stops) ? stops.slice(0, 2) : [];
        const distanceKm = calculateTotalRouteDistance(
            { lat: pickup_lat, lng: pickup_lng },
            stopsList.map(s => ({ lat: s.lat, lng: s.lng })),
            { lat: dest_lat, lng: dest_lng }
        );
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

app.get('/admin/promo-codes', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query('SELECT * FROM promo_codes ORDER BY created_at DESC');
        res.json({ codes: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/promo-codes', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { code, discount_type, discount_value, max_uses, expires_at } = req.body;
        if (!code || !discount_type || !discount_value)
            return res.status(400).json({ error: 'Code, type, and value are required' });
        await pool.query(
            `INSERT INTO promo_codes (code, discount_type, discount_value, max_uses, expires_at)
             VALUES ($1, $2, $3, $4, $5)`,
            [code.trim().toUpperCase(), discount_type, discount_value, max_uses || null, expires_at || null]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/promo-codes/:id/toggle', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        await pool.query('UPDATE promo_codes SET is_active = NOT is_active WHERE id=$1', [req.params.id]);
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/withdrawal-requests', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query(
            `SELECT w.*, u.name as rider_name FROM withdrawal_requests w
             JOIN users u ON w.rider_id = u.id
             ORDER BY w.requested_at DESC LIMIT 100`
        );
        res.json({ requests: rows });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/withdrawal-requests/:id/complete', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        await pool.query(
            `UPDATE withdrawal_requests SET status='paid', processed_at=NOW() WHERE id=$1`,
            [req.params.id]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/withdrawal-requests/:id/reject', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { note } = req.body;
        const requestResult = await pool.query('SELECT rider_id, amount, status FROM withdrawal_requests WHERE id=$1', [req.params.id]);
        if (requestResult.rows.length === 0) return res.status(404).json({ error: 'Request not found' });
        const wr = requestResult.rows[0];
        if (wr.status !== 'pending') return res.status(400).json({ error: 'Request already processed' });

        await pool.query('UPDATE users SET wallet_balance = wallet_balance + $1 WHERE id=$2', [wr.amount, wr.rider_id]);
        await pool.query(
            `UPDATE withdrawal_requests SET status='rejected', processed_at=NOW(), admin_note=$1 WHERE id=$2`,
            [note || 'Rejected by admin', req.params.id]
        );
        res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/unpaid-rides', async (req, res) => {
    try {
        const adminKey = req.headers['x-admin-key'];
        if (adminKey !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
        const { rows } = await pool.query(
            `SELECT r.id, r.fare, r.payment_status, r.completed_at, u.name as passenger_name, u.phone as passenger_phone
             FROM rides r JOIN users u ON r.passenger_id = u.id
             WHERE r.status='completed' AND r.payment_status IN ('pending', 'failed')
             ORDER BY r.completed_at DESC LIMIT 100`
        );
        res.json({ rides: rows });
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
