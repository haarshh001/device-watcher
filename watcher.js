const axios = require('axios');
const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'store.json');

// ═══ PERSISTENT JSON STORE ═══
function loadStore() {
    try {
        if (fs.existsSync(STORE_PATH)) {
            return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8'));
        }
    } catch (e) {
        console.error('[STORE] Failed to load:', e.message);
    }
    return { databases: [], watches: [], settings: { intervalMinutes: 60 }, logs: [] };
}

function saveStore(store) {
    try {
        const dir = path.dirname(STORE_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
    } catch (e) {
        console.error('[STORE] Failed to save:', e.message);
    }
}

// ═══ TELEGRAM NOTIFICATION ═══
async function sendTelegram(message) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    if (!token || !chatId || token === 'your_bot_token_here') {
        console.log('[TG] Skipping — no bot token configured');
        return false;
    }
    try {
        await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
            chat_id: chatId,
            text: message,
            parse_mode: 'HTML'
        }, { timeout: 10000 });
        console.log('[TG] Notification sent');
        return true;
    } catch (e) {
        console.error('[TG] Failed to send:', e.response?.data?.description || e.message);
        return false;
    }
}

// ═══ FIREBASE DEVICE STATUS CHECK ═══
async function checkDeviceStatus(firebaseUrl, apiKey, deviceId) {
    const authSuffix = apiKey ? `?auth=${apiKey}` : '';
    const url = `${firebaseUrl}/clients/${deviceId}.json${authSuffix}`;
    try {
        const res = await axios.get(url, { timeout: 15000 });
        if (res.data && typeof res.data === 'object') {
            return {
                online: res.data.status === true,
                battery: res.data.battery || '-',
                ip: res.data.ip_address || '-',
                model: res.data.modelName || '-',
                customPh: res.data.customPh || res.data.mobNo || '-',
                found: true
            };
        }
        return { online: false, found: false };
    } catch (e) {
        console.error(`[POLL] Error checking ${deviceId}:`, e.message);
        return { online: false, found: false, error: e.message };
    }
}

// ═══ MAIN POLL FUNCTION ═══
async function pollAll(specificWatchId = null) {
    const store = loadStore();
    const now = Date.now();
    let changed = false;

    // Remove expired watches first
    const before = store.watches.length;
    store.watches = store.watches.filter(w => {
        if (w.expiresAt && now > w.expiresAt) {
            console.log(`[POLL] Watch expired for ${w.deviceId}`);
            return false;
        }
        return true;
    });
    if (store.watches.length !== before) changed = true;

    const targetWatches = specificWatchId 
        ? store.watches.filter(w => w.id === specificWatchId)
        : store.watches.filter(w => w.cronEnabled !== false);

    console.log(`[POLL] Scanning ${targetWatches.length} watched device(s)...`);

    for (const watch of targetWatches) {
        const db = store.databases.find(d => d.id === watch.databaseId);
        if (!db) {
            console.log(`[POLL] Database ${watch.databaseId} not found for watch ${watch.deviceId}, skipping`);
            continue;
        }

        const result = await checkDeviceStatus(db.url, db.apiKey, watch.deviceId);
        const wasOnline = watch.lastStatus === true;
        const isNowOnline = result.online === true;

        // Update watch state
        watch.lastCheck = now;
        watch.lastStatus = result.online;
        watch.battery = result.battery || watch.battery; // Keep old battery if offline
        watch.ip = result.ip || watch.ip;
        watch.model = result.model || watch.model;
        watch.phone = result.customPh || watch.phone;
        watch.found = result.found;
        changed = true;

        const timeStr = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
        const noteStr = watch.note ? `<b>Note:</b> ${watch.note}\n` : '';

        // If it JUST came online
        if (isNowOnline && !wasOnline) {
            const msg = `🟢 <b>DEVICE ONLINE ALERT</b>\n\n` +
                `<b>Device:</b> <code>${watch.deviceId}</code>\n` +
                `<b>Database:</b> ${db.label}\n` +
                noteStr +
                `<b>Phone:</b> ${result.customPh}\n` +
                `<b>Battery:</b> ${result.battery}\n` +
                `<b>IP:</b> ${result.ip}\n` +
                `<b>Model:</b> ${result.model}\n\n` +
                `🕐 Detected at: ${timeStr}`;

            const sent = await sendTelegram(msg);

            store.logs.unshift({
                type: 'online',
                deviceId: watch.deviceId,
                database: db.label,
                battery: result.battery,
                time: now,
                telegramSent: sent
            });
            if (store.logs.length > 100) store.logs = store.logs.slice(0, 100);

            console.log(`[POLL] 🟢 ${watch.deviceId} came ONLINE in ${db.label}!`);
            
        // If it JUST went offline (was online in the previous check)
        } else if (!isNowOnline && wasOnline) {
            const statusStr = result.found ? 'Offline' : 'Not Found (Deleted)';
            const msg = `🔴 <b>DEVICE OFFLINE ALERT</b>\n\n` +
                `<b>Device:</b> <code>${watch.deviceId}</code>\n` +
                `<b>Database:</b> ${db.label}\n` +
                noteStr +
                `<b>Last Battery:</b> ${watch.battery || '-'}\n` +
                `<b>Status:</b> ${statusStr}\n\n` +
                `🕐 Detected at: ${timeStr}`;

            const sent = await sendTelegram(msg);

            store.logs.unshift({
                type: 'offline',
                deviceId: watch.deviceId,
                database: db.label,
                battery: watch.battery,
                time: now,
                telegramSent: sent
            });
            if (store.logs.length > 100) store.logs = store.logs.slice(0, 100);

            console.log(`[POLL] 🔴 ${watch.deviceId} went OFFLINE in ${db.label} (Found: ${result.found})`);
            
        } else if (!isNowOnline) {
            console.log(`[POLL] 🔴 ${watch.deviceId} still offline in ${db.label} (Found: ${result.found})`);
        } else {
            console.log(`[POLL] 🟢 ${watch.deviceId} already online in ${db.label}`);
        }
    }

    if (changed) saveStore(store);
    console.log(`[POLL] Scan complete.`);
    return store;
}

// ═══ TEST TELEGRAM CONNECTION ═══
async function testTelegram() {
    return sendTelegram('🔔 <b>Device Watcher Connected</b>\n\nYour Telegram notifications are working!');
}

module.exports = { loadStore, saveStore, pollAll, testTelegram, sendTelegram };
