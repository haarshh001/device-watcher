require('dotenv').config();
const express = require('express');
const cron = require('node-cron');
const path = require('path');
const { loadStore, saveStore, pollAll, testTelegram } = require('./watcher');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ═══ CRON SCHEDULER ═══
let cronJob = null;

function startCron() {
    if (cronJob) cronJob.stop();
    const store = loadStore();
    const mins = store.settings?.intervalMinutes || 60;
    const expr = `*/${mins} * * * *`;
    console.log(`[CRON] Scheduling polls every ${mins} minute(s): ${expr}`);
    cronJob = cron.schedule(expr, async () => {
        console.log(`[CRON] Triggered at ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`);
        await pollAll();
    });
}

// ═══ API ROUTES ═══

// Get full config
app.get('/api/config', (req, res) => {
    const store = loadStore();
    // Hide API keys from frontend
    const safeDbs = store.databases.map(d => ({ ...d, apiKey: d.apiKey ? '••••••' : '' }));
    res.json({ ...store, databases: safeDbs });
});

// Add database
app.post('/api/databases', (req, res) => {
    const { url, apiKey, label } = req.body;
    if (!url || !label) return res.status(400).json({ error: 'URL and label are required' });

    const store = loadStore();
    const id = 'db_' + Date.now();
    const cleanUrl = url.replace(/\/+$/, ''); // strip trailing slashes
    store.databases.push({ id, url: cleanUrl, apiKey: apiKey || '', label });
    saveStore(store);
    res.json({ success: true, id });
});

// Delete database
app.delete('/api/databases/:id', (req, res) => {
    const store = loadStore();
    const before = store.databases.length;
    store.databases = store.databases.filter(d => d.id !== req.params.id);
    // Also remove watches tied to this database
    store.watches = store.watches.filter(w => w.databaseId !== req.params.id);
    if (store.databases.length === before) return res.status(404).json({ error: 'Not found' });
    saveStore(store);
    res.json({ success: true });
});

// Add watch
app.post('/api/watches', (req, res) => {
    const { deviceId, databaseId, durationHours } = req.body;
    if (!deviceId || !databaseId) return res.status(400).json({ error: 'Device ID and database are required' });

    const store = loadStore();
    if (!store.databases.find(d => d.id === databaseId)) {
        return res.status(400).json({ error: 'Database not found' });
    }

    // Check for duplicate
    const existing = store.watches.find(w => w.deviceId === deviceId && w.databaseId === databaseId);
    if (existing) return res.status(400).json({ error: 'This device is already being watched in this database' });

    const id = 'w_' + Date.now();
    const now = Date.now();
    const expiresAt = durationHours ? now + (durationHours * 60 * 60 * 1000) : null;

    store.watches.push({
        id,
        deviceId: deviceId.trim().toLowerCase(),
        databaseId,
        createdAt: now,
        expiresAt,
        durationHours: durationHours || null,
        lastCheck: null,
        lastStatus: null,
        battery: null,
        ip: null,
        model: null,
        phone: null,
        found: null
    });
    saveStore(store);
    res.json({ success: true, id });
});

// Delete watch
app.delete('/api/watches/:id', (req, res) => {
    const store = loadStore();
    const before = store.watches.length;
    store.watches = store.watches.filter(w => w.id !== req.params.id);
    if (store.watches.length === before) return res.status(404).json({ error: 'Not found' });
    saveStore(store);
    res.json({ success: true });
});

// Update settings
app.put('/api/settings', (req, res) => {
    const { intervalMinutes } = req.body;
    if (!intervalMinutes || intervalMinutes < 1) return res.status(400).json({ error: 'Invalid interval' });

    const store = loadStore();
    store.settings.intervalMinutes = parseInt(intervalMinutes);
    saveStore(store);
    startCron(); // restart cron with new interval
    res.json({ success: true, intervalMinutes: store.settings.intervalMinutes });
});

// Get logs
app.get('/api/logs', (req, res) => {
    const store = loadStore();
    res.json(store.logs || []);
});

// Manual scan
app.post('/api/scan-now', async (req, res) => {
    try {
        const store = await pollAll();
        res.json({ success: true, watches: store.watches.length });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Test telegram
app.post('/api/test-telegram', async (req, res) => {
    const ok = await testTelegram();
    res.json({ success: ok });
});

// SPA fallback
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ═══ START ═══
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`[SERVER] Device Watcher running on port ${PORT}`);
    startCron();

    // Run initial poll 5 seconds after startup
    setTimeout(() => {
        const store = loadStore();
        if (store.watches.length > 0) {
            console.log('[SERVER] Running initial poll...');
            pollAll();
        }
    }, 5000);
});
