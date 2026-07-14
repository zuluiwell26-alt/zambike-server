-- ZAMBIKE DATABASE SCHEMA

-- Users table (both passengers and riders)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('passenger', 'rider')),
    password_hash TEXT NOT NULL,
    profile_photo TEXT,
    license_photo TEXT,
    bike_plate TEXT,
    is_approved BOOLEAN DEFAULT FALSE,
    is_online BOOLEAN DEFAULT FALSE,
    rating NUMERIC(3,2) DEFAULT 5.00,
    total_rides INTEGER DEFAULT 0,
    total_earnings NUMERIC DEFAULT 0,
    total_trips INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lat NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_lng NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS home_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_lat NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_lng NUMERIC(10,7);
ALTER TABLE users ADD COLUMN IF NOT EXISTS work_address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS vehicle_type TEXT DEFAULT 'bike';
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_reward_granted BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_free_rides_remaining INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_rides_remaining INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS discount_rides_percent NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS new_signup_discount_used BOOLEAN DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS wallet_balance NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS commission_owed NUMERIC DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS id_verified_at TIMESTAMP;

-- Rider locations (updated in real time)
CREATE TABLE IF NOT EXISTS rider_locations (
    rider_id INTEGER PRIMARY KEY REFERENCES users(id),
    latitude NUMERIC(10,7) NOT NULL,
    longitude NUMERIC(10,7) NOT NULL,
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Rides table
CREATE TABLE IF NOT EXISTS rides (
    id SERIAL PRIMARY KEY,
    passenger_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    pickup_lat NUMERIC(10,7) NOT NULL,
    pickup_lng NUMERIC(10,7) NOT NULL,
    pickup_address TEXT,
    dest_lat NUMERIC(10,7) NOT NULL,
    dest_lng NUMERIC(10,7) NOT NULL,
    dest_address TEXT,
    distance_km NUMERIC(6,2),
    fare NUMERIC(10,2),
    zambike_cut NUMERIC(10,2),
    rider_earnings NUMERIC(10,2),
    status TEXT DEFAULT 'requested' CHECK (status IN (
        'requested', 'accepted', 'arriving', 'in_progress', 'completed', 'cancelled'
    )),
    payment_method TEXT CHECK (payment_method IN ('airtel', 'mtn')),
    payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_reference TEXT,
    requested_at TIMESTAMP DEFAULT NOW(),
    accepted_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancel_reason TEXT
);

ALTER TABLE rides ADD COLUMN IF NOT EXISTS vehicle_type TEXT DEFAULT 'bike';
ALTER TABLE rides ADD COLUMN IF NOT EXISTS scheduled_time TIMESTAMP;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS promo_code TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS discount_amount NUMERIC DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS original_fare NUMERIC;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS used_commission_free BOOLEAN DEFAULT FALSE;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS share_token TEXT UNIQUE;

ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_payment_method_check;
ALTER TABLE rides ADD CONSTRAINT rides_payment_method_check CHECK (payment_method IN ('airtel', 'mtn', 'cash'));

-- Extra stops along a ride, between pickup and final destination
CREATE TABLE IF NOT EXISTS ride_stops (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    seq INTEGER NOT NULL,
    lat NUMERIC(10,7) NOT NULL,
    lng NUMERIC(10,7) NOT NULL,
    address TEXT,
    wait_minutes INTEGER DEFAULT 0,
    reached_at TIMESTAMP
);

ALTER TABLE ride_stops ADD COLUMN IF NOT EXISTS wait_minutes INTEGER DEFAULT 0;

-- Ride chat messages
CREATE TABLE IF NOT EXISTS ride_messages (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    sender_id INTEGER REFERENCES users(id),
    sender_role TEXT NOT NULL CHECK (sender_role IN ('passenger', 'rider')),
    message TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Promo codes (admin-created)
CREATE TABLE IF NOT EXISTS promo_codes (
    id SERIAL PRIMARY KEY,
    code TEXT UNIQUE NOT NULL,
    discount_type TEXT NOT NULL CHECK (discount_type IN ('percent', 'flat')),
    discount_value NUMERIC NOT NULL,
    max_uses INTEGER,
    uses_count INTEGER DEFAULT 0,
    is_active BOOLEAN DEFAULT TRUE,
    expires_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Wallet withdrawal requests
CREATE TABLE IF NOT EXISTS withdrawal_requests (
    id SERIAL PRIMARY KEY,
    rider_id INTEGER REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    phone_number TEXT NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('airtel', 'mtn')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'rejected')),
    requested_at TIMESTAMP DEFAULT NOW(),
    processed_at TIMESTAMP,
    admin_note TEXT
);

-- Log of commission payments riders send in to settle owed commission
CREATE TABLE IF NOT EXISTS commission_payments (
    id SERIAL PRIMARY KEY,
    rider_id INTEGER REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    recorded_at TIMESTAMP DEFAULT NOW(),
    note TEXT
);

-- Payments table
CREATE TABLE IF NOT EXISTS payments (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    passenger_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    amount NUMERIC(10,2) NOT NULL,
    zambike_cut NUMERIC(10,2) NOT NULL,
    rider_earnings NUMERIC(10,2) NOT NULL,
    network TEXT NOT NULL CHECK (network IN ('airtel', 'mtn')),
    reference TEXT UNIQUE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
    created_at TIMESTAMP DEFAULT NOW()
);

-- Ratings table
CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY,
    ride_id INTEGER REFERENCES rides(id),
    rated_by INTEGER REFERENCES users(id),
    rated_user INTEGER REFERENCES users(id),
    stars INTEGER CHECK (stars BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Fare settings (admin can change these)
CREATE TABLE IF NOT EXISTS fare_settings (
    id SERIAL PRIMARY KEY,
    base_fare NUMERIC DEFAULT 10.00,
    per_km_rate NUMERIC DEFAULT 5.00,
    zambike_percentage NUMERIC DEFAULT 10,
    updated_at TIMESTAMP DEFAULT NOW()
);

INSERT INTO fare_settings (base_fare, per_km_rate, zambike_percentage)
VALUES (10.00, 5.00, 10)
ON CONFLICT DO NOTHING;

-- Admin table
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Community-submitted map corrections (wrong roads, better pickup points, unnamed roads, etc.)
CREATE TABLE IF NOT EXISTS map_corrections (
    id SERIAL PRIMARY KEY,
    reporter_id INTEGER REFERENCES users(id),
    lat NUMERIC(10,7) NOT NULL,
    lng NUMERIC(10,7) NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('wrong_road', 'better_pickup', 'unnamed_road', 'other')),
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'reviewed', 'applied', 'dismissed')),
    created_at TIMESTAMP DEFAULT NOW(),
    reviewed_at TIMESTAMP,
    admin_note TEXT
);

-- Phone number verification codes sent during registration
CREATE TABLE IF NOT EXISTS phone_verifications (
    id SERIAL PRIMARY KEY,
    phone TEXT NOT NULL,
    code TEXT NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Passengers' favorite drivers, for requesting a specific rider again
CREATE TABLE IF NOT EXISTS favorite_drivers (
    id SERIAL PRIMARY KEY,
    passenger_id INTEGER REFERENCES users(id),
    rider_id INTEGER REFERENCES users(id),
    created_at TIMESTAMP DEFAULT NOW(),
    UNIQUE(passenger_id, rider_id)
);

ALTER TABLE rides ADD COLUMN IF NOT EXISTS preferred_rider_id INTEGER REFERENCES users(id);
