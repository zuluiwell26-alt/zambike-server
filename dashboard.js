const express = require('express');
const router = express.Router();

function adminOnly(req, res, next) {
    const key = req.headers['x-admin-key'] || req.query.key;
    if (key !== process.env.ADMIN_KEY) return res.status(403).send('Forbidden');
    next();
}

router.get('/', adminOnly, async (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
<title>Zambike Admin</title>
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:sans-serif;background:#0a0a0a;color:#fff;min-height:100vh}
.header{background:#111;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #222}
.logo{font-size:20px;font-weight:700;color:#f59e0b}
.nav{display:flex;gap:16px}
.nav a{color:#9ca3af;text-decoration:none;font-size:13px;padding:6px 12px;border-radius:8px}
.nav a:hover{background:#1f1f1f;color:#fff}
.content{padding:24px;max-width:1200px;margin:0 auto}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-bottom:24px}
.stat{background:#111;border:1px solid #222;border-radius:14px;padding:20px}
.stat-label{font-size:11px;color:#6b7280;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px}
.stat-value{font-size:32px;font-weight:700;color:#f59e0b}
.stat-sub{font-size:11px;color:#4b5563;margin-top:4px}
.section{background:#111;border:1px solid #222;border-radius:14px;padding:20px;margin-bottom:20px}
.section-title{font-size:14px;font-weight:600;color:#f59e0b;margin-bottom:16px;letter-spacing:1px;text-transform:uppercase}
table{width:100%;border-collapse:collapse}
th{font-size:11px;color:#6b7280;text-align:left;padding:8px 12px;border-bottom:1px solid #222;text-transform:uppercase}
td{font-size:13px;color:#e5e7eb;padding:10px 12px;border-bottom:1px solid #1a1a1a}
tr:last-child td{border-bottom:none}
.badge{padding:3px 8px;border-radius:20px;font-size:10px;font-weight:600}
.badge-green{background:#052e16;color:#4ade80}
.badge-yellow{background:#422006;color:#fbbf24}
.badge-red{background:#2d0a0a;color:#f87171}
.badge-blue{background:#0c1a3d;color:#60a5fa}
.btn{padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer;border:none}
.btn-green{background:#065f46;color:#4ade80}
.btn-red{background:#7f1d1d;color:#f87171}
.search{width:100%;background:#1a1a1a;border:1px solid #333;color:#fff;padding:10px 14px;border-radius:8px;font-size:13px;outline:none;margin-bottom:16px}
.tabs{display:flex;gap:8px;margin-bottom:20px}
.tab{padding:8px 18px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;border:none;background:#1a1a1a;color:#6b7280}
.tab.active{background:#f59e0b;color:#000}
.tab-content{display:none}
.tab-content.active{display:block}
@media(max-width:768px){.stats{grid-template-columns:1fr 1fr}.stat-value{font-size:24px}}
</style>
</head>
<body>
<div class="header">
  <div class="logo">🏍️ Zambike Admin</div>
  <div class="nav">
    <a href="?key=${req.query.key}">Dashboard</a>
    <a href="?key=${req.query.key}&page=riders">Riders</a>
    <a href="?key=${req.query.key}&page=passengers">Passengers</a>
    <a href="?key=${req.query.key}&page=rides">Rides</a>
    <a href="?key=${req.query.key}&page=settings">Settings</a>
  </div>
</div>
<div class="content">
  <div id="main-content">Loading...</div>
</div>
<script>
const KEY = '${req.query.key}';
const PAGE = '${req.query.page || 'dashboard'}';

async function fetchData(url) {
    const res = await fetch(url, { headers: { 'x-admin-key': KEY } });
    return res.json();
}

async function loadDashboard() {
    const stats = await fetchData('/admin/stats');
    const rides = await fetchData('/admin/recent-rides');
    const pending = await fetchData('/admin/pending-riders');

    document.getElementById('main-content').innerHTML = \`
    <div class="stats">
        <div class="stat">
            <div class="stat-label">Total Riders</div>
            <div class="stat-value">\${stats.total_riders}</div>
            <div class="stat-sub">Approved motorbike riders</div>
        </div>
        <div class="stat">
            <div class="stat-label">Total Passengers</div>
            <div class="stat-value">\${stats.total_passengers}</div>
            <div class="stat-sub">Registered users</div>
        </div>
        <div class="stat">
            <div class="stat-label">Total Rides</div>
            <div class="stat-value">\${stats.total_rides}</div>
            <div class="stat-sub">Completed rides</div>
        </div>
        <div class="stat">
            <div class="stat-label">Total Earnings</div>
            <div class="stat-value">K\${parseFloat(stats.total_earnings || 0).toFixed(2)}</div>
            <div class="stat-sub">Zambike 10% commission</div>
        </div>
    </div>

    \${pending.riders && pending.riders.length > 0 ? \`
    <div class="section">
        <div class="section-title">⏳ Pending Rider Approvals (\${pending.riders.length})</div>
        <table>
            <tr><th>Name</th><th>Phone</th><th>Registered</th><th>Action</th></tr>
            \${pending.riders.map(r => \`
            <tr>
                <td>\${r.name}</td>
                <td>\${r.phone}</td>
                <td>\${new Date(r.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-green" onclick="approveRider(\${r.id})">Approve</button>
                    &nbsp;
                    <button class="btn btn-red" onclick="suspendUser(\${r.id})">Reject</button>
                </td>
            </tr>\`).join('')}
        </table>
    </div>\` : ''}

    <div class="section">
        <div class="section-title">🏍️ Recent Rides</div>
        <table>
            <tr><th>Passenger</th><th>Rider</th><th>From</th><th>To</th><th>Fare</th><th>Status</th><th>Time</th></tr>
            \${rides.rides && rides.rides.map(r => \`
            <tr>
                <td>\${r.passenger_name || '-'}</td>
                <td>\${r.rider_name || 'Not assigned'}</td>
                <td>\${r.pickup_address || r.pickup_lat + ',' + r.pickup_lng}</td>
                <td>\${r.dest_address || r.dest_lat + ',' + r.dest_lng}</td>
                <td>K\${parseFloat(r.fare || 0).toFixed(2)}</td>
                <td><span class="badge \${r.status === 'completed' ? 'badge-green' : r.status === 'cancelled' ? 'badge-red' : 'badge-yellow'}">\${r.status}</span></td>
                <td>\${new Date(r.requested_at).toLocaleTimeString()}</td>
            </tr>\`).join('') || '<tr><td colspan="7" style="text-align:center;color:#4b5563;padding:20px">No rides yet</td></tr>'}
        </table>
    </div>\`;
}

async function loadRiders() {
    const data = await fetchData('/admin/all-riders');
    document.getElementById('main-content').innerHTML = \`
    <div class="section">
        <div class="section-title">🏍️ All Riders</div>
        <input class="search" placeholder="Search by name or phone..." oninput="filterTable(this.value,'riders-table')">
        <table id="riders-table">
            <tr><th>Name</th><th>Phone</th><th>Status</th><th>Rides</th><th>Earnings</th><th>Rating</th><th>Action</th></tr>
            \${data.riders && data.riders.map(r => \`
            <tr data-search="\${r.name.toLowerCase()} \${r.phone}">
                <td>\${r.name}</td>
                <td>\${r.phone}</td>
                <td>
                    \${r.is_approved ? '<span class="badge badge-green">Approved</span>' : '<span class="badge badge-yellow">Pending</span>'}
                    \${r.is_online ? ' <span class="badge badge-blue">Online</span>' : ''}
                    \${!r.is_active ? ' <span class="badge badge-red">Suspended</span>' : ''}
                </td>
                <td>\${r.total_rides}</td>
                <td>K\${parseFloat(r.total_earnings || 0).toFixed(2)}</td>
                <td>⭐ \${parseFloat(r.rating || 5).toFixed(1)}</td>
                <td>
                    \${!r.is_approved ? \`<button class="btn btn-green" onclick="approveRider(\${r.id})">Approve</button> \` : ''}
                    \${r.is_active ? \`<button class="btn btn-red" onclick="suspendUser(\${r.id})">Suspend</button>\` : '<span style="color:#4b5563">Suspended</span>'}
                </td>
            </tr>\`).join('') || '<tr><td colspan="7" style="text-align:center;color:#4b5563;padding:20px">No riders yet</td></tr>'}
        </table>
    </div>\`;
}

async function loadPassengers() {
    const data = await fetchData('/admin/all-passengers');
    document.getElementById('main-content').innerHTML = \`
    <div class="section">
        <div class="section-title">👤 All Passengers</div>
        <input class="search" placeholder="Search by name or phone..." oninput="filterTable(this.value,'passengers-table')">
        <table id="passengers-table">
            <tr><th>Name</th><th>Phone</th><th>Total Trips</th><th>Rating</th><th>Joined</th><th>Action</th></tr>
            \${data.passengers && data.passengers.map(p => \`
            <tr data-search="\${p.name.toLowerCase()} \${p.phone}">
                <td>\${p.name}</td>
                <td>\${p.phone}</td>
                <td>\${p.total_trips}</td>
                <td>⭐ \${parseFloat(p.rating || 5).toFixed(1)}</td>
                <td>\${new Date(p.created_at).toLocaleDateString()}</td>
                <td>\${p.is_active ? \`<button class="btn btn-red" onclick="suspendUser(\${p.id})">Suspend</button>\` : '<span style="color:#4b5563">Suspended</span>'}</td>
            </tr>\`).join('') || '<tr><td colspan="6" style="text-align:center;color:#4b5563;padding:20px">No passengers yet</td></tr>'}
        </table>
    </div>\`;
}

async function loadRides() {
    const data = await fetchData('/admin/all-rides');
    document.getElementById('main-content').innerHTML = \`
    <div class="section">
        <div class="section-title">🛵 All Rides</div>
        <input class="search" placeholder="Search..." oninput="filterTable(this.value,'rides-table')">
        <table id="rides-table">
            <tr><th>ID</th><th>Passenger</th><th>Rider</th><th>Distance</th><th>Fare</th><th>Zambike Cut</th><th>Status</th><th>Payment</th><th>Time</th></tr>
            \${data.rides && data.rides.map(r => \`
            <tr data-search="\${r.passenger_name || ''} \${r.rider_name || ''} \${r.status}">
                <td>#\${r.id}</td>
                <td>\${r.passenger_name || '-'}</td>
                <td>\${r.rider_name || 'Not assigned'}</td>
                <td>\${parseFloat(r.distance_km || 0).toFixed(1)} km</td>
                <td>K\${parseFloat(r.fare || 0).toFixed(2)}</td>
                <td>K\${parseFloat(r.zambike_cut || 0).toFixed(2)}</td>
                <td><span class="badge \${r.status === 'completed' ? 'badge-green' : r.status === 'cancelled' ? 'badge-red' : 'badge-yellow'}">\${r.status}</span></td>
                <td><span class="badge \${r.payment_status === 'paid' ? 'badge-green' : 'badge-yellow'}">\${r.payment_status}</span></td>
                <td>\${new Date(r.requested_at).toLocaleString()}</td>
            </tr>\`).join('') || '<tr><td colspan="9" style="text-align:center;color:#4b5563;padding:20px">No rides yet</td></tr>'}
        </table>
    </div>\`;
}

async function loadSettings() {
    const data = await fetchData('/admin/fare-settings-get');
    document.getElementById('main-content').innerHTML = \`
    <div class="section" style="max-width:400px">
        <div class="section-title">⚙️ Fare Settings</div>
        <div style="margin-bottom:16px">
            <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:6px">Base Fare (K)</label>
            <input id="base_fare" type="number" value="\${data.base_fare}" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#fff;padding:10px;border-radius:8px;font-size:14px;outline:none">
        </div>
        <div style="margin-bottom:16px">
            <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:6px">Per KM Rate (K)</label>
            <input id="per_km" type="number" value="\${data.per_km_rate}" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#fff;padding:10px;border-radius:8px;font-size:14px;outline:none">
        </div>
        <div style="margin-bottom:20px">
            <label style="font-size:12px;color:#6b7280;display:block;margin-bottom:6px">Zambike Commission (%)</label>
            <input id="commission" type="number" value="\${data.zambike_percentage}" style="width:100%;background:#1a1a1a;border:1px solid #333;color:#fff;padding:10px;border-radius:8px;font-size:14px;outline:none">
        </div>
        <button class="btn btn-green" style="width:100%;padding:12px;font-size:14px" onclick="saveFareSettings()">Save Settings</button>
        <div id="settings-msg" style="margin-top:10px;font-size:12px;text-align:center"></div>
    </div>\`;
}

async function approveRider(id) {
    await fetch('/admin/approve-rider/' + id, { method: 'POST', headers: { 'x-admin-key': KEY } });
    alert('Rider approved!');
    location.reload();
}

async function suspendUser(id) {
    if (!confirm('Are you sure you want to suspend this user?')) return;
    await fetch('/admin/suspend-user/' + id, { method: 'POST', headers: { 'x-admin-key': KEY } });
    alert('User suspended.');
    location.reload();
}

async function saveFareSettings() {
    const res = await fetch('/admin/fare-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-key': KEY },
        body: JSON.stringify({
            base_fare: document.getElementById('base_fare').value,
            per_km_rate: document.getElementById('per_km').value,
            zambike_percentage: document.getElementById('commission').value
        })
    });
    const d = await res.json();
    document.getElementById('settings-msg').textContent = d.success ? '✅ Saved!' : '❌ Error saving';
}

function filterTable(q, tableId) {
    document.querySelectorAll('#' + tableId + ' tr[data-search]').forEach(row => {
        row.style.display = row.dataset.search.includes(q.toLowerCase()) ? '' : 'none';
    });
}

// Load the right page
if (PAGE === 'riders') loadRiders();
else if (PAGE === 'passengers') loadPassengers();
else if (PAGE === 'rides') loadRides();
else if (PAGE === 'settings') loadSettings();
else loadDashboard();

// Auto refresh every 30 seconds
setInterval(() => {
    if (PAGE === 'dashboard') loadDashboard();
}, 30000);
</script>
</body>
</html>`);
});

module.exports = router;
