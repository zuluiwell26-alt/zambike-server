-- ZAMBIKE DATABASE SCHEMA

-- Users table (both passengers and riders)
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    phone TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('passenger', 'rider')),
    password_hash TEXT NOT NULL,
    profile_photo TEXT,
    -- Rider specific
    license_photo TEXT,
    bike_plate TEXT,
    is_approved BOOLEAN DEFAULT FALSE,  -- admin must approve riders
    is_online BOOLEAN DEFAULT FALSE,
    rating NUMERIC(3,2) DEFAULT 5.00,
    total_rides INTEGER DEFAULT 0,
    total_earnings NUMERIC DEFAULT 0,
    -- Passenger specific
    total_trips INTEGER DEFAULT 0,
    -- Account status
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT NOW()
);

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
    -- Pickup
    pickup_lat NUMERIC(10,7) NOT NULL,
    pickup_lng NUMERIC(10,7) NOT NULL,
    pickup_address TEXT,
    -- Destination
    dest_lat NUMERIC(10,7) NOT NULL,
    dest_lng NUMERIC(10,7) NOT NULL,
    dest_address TEXT,
    -- Fare
    distance_km NUMERIC(6,2),
    fare NUMERIC(10,2),          -- total fare
    zambike_cut NUMERIC(10,2),   -- 10% to Zambike
    rider_earnings NUMERIC(10,2), -- 90% to rider
    -- Status
    status TEXT DEFAULT 'requested' CHECK (status IN (
        'requested',   -- passenger requested
        'accepted',    -- rider accepted
        'arriving',    -- rider on way to pickup
        'in_progress', -- ride started
        'completed',   -- ride finished
        'cancelled'    -- cancelled by either party
    )),
    -- Payment
    payment_method TEXT CHECK (payment_method IN ('airtel', 'mtn')),
    payment_status TEXT DEFAULT 'pending' CHECK (payment_status IN ('pending', 'paid', 'failed')),
    payment_reference TEXT,
    -- Timestamps
    requested_at TIMESTAMP DEFAULT NOW(),
    accepted_at TIMESTAMP,
    started_at TIMESTAMP,
    completed_at TIMESTAMP,
    cancelled_at TIMESTAMP,
    cancel_reason TEXT
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
    rated_by INTEGER REFERENCES users(id),   -- who gave the rating
    rated_user INTEGER REFERENCES users(id), -- who received the rating
    stars INTEGER CHECK (stars BETWEEN 1 AND 5),
    comment TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Fare settings (admin can change these)
CREATE TABLE IF NOT EXISTS fare_settings (
    id SERIAL PRIMARY KEY,
    base_fare NUMERIC DEFAULT 10.00,      -- K10 base fare
    per_km_rate NUMERIC DEFAULT 5.00,     -- K5 per km
    zambike_percentage NUMERIC DEFAULT 10, -- 10% commission
    updated_at TIMESTAMP DEFAULT NOW()
);

-- Insert default fare settings
INSERT INTO fare_settings (base_fare, per_km_rate, zambike_percentage)
VALUES (10.00, 5.00, 10)
ON CONFLICT DO NOTHING;

-- Admin table
CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT NOW()
);
