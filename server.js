const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = 3000;

// Enable CORS so HTML file can connect to this server
app.use(cors());
app.use(express.json());

// Variables to store states
let waStatus = 'DISCONNECTED'; // DISCONNECTED, QR_READY, CONNECTED
let latestQR = null;
let ackQueue = []; // To store live message delivery/read statuses

// Initialize WhatsApp Client (With your exact config)
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

// --- WHATSAPP EVENT LISTENERS ---

client.on('qr', async (qr) => {
    console.log('🟡 New QR Code Generated. Awaiting scan...');
    waStatus = 'QR_READY';
    // Convert text QR to an Image Buffer for the frontend
    latestQR = await qrcode.toBuffer(qr, { type: 'png' });
});

client.on('ready', () => {
    console.log('🟢 WHATSAPP IS CONNECTED & READY!');
    waStatus = 'CONNECTED';
    latestQR = null;
});

client.on('disconnected', (reason) => {
    console.log('🔴 WHATSAPP DISCONNECTED:', reason);
    waStatus = 'DISCONNECTED';
});

// Track Message Status (Read, Delivered)
client.on('message_ack', (msg, ack) => {
    let statusText = '';
    if(ack === 2) statusText = 'delivered';
    if(ack === 3) statusText = 'read';
    
    if(statusText) {
        ackQueue.push({ to: msg.to, status: statusText });
        // Keep queue small to prevent memory leaks
        if(ackQueue.length > 50) ackQueue.shift();
    }
});

// Track Incoming Replies
client.on('message', msg => {
    if(!msg.from.includes('@g.us')) {
        ackQueue.push({ to: msg.from, status: 'replied', text: msg.body });
        if(ackQueue.length > 50) ackQueue.shift();
    }
});

// --- API ENDPOINTS FOR HTML FRONTEND ---

// 1. Check Status
app.get('/api/whatsapp/status', (req, res) => {
    res.json({ status: waStatus });
});

// 2. Serve QR Code Image
app.get('/api/whatsapp/qr.png', (req, res) => {
    if (waStatus === 'QR_READY' && latestQR) {
        res.setHeader('Content-Type', 'image/png');
        res.send(latestQR);
    } else {
        res.status(404).send('QR not available');
    }
});

// 3. Send Message Endpoint (Handles both Individuals & Groups)
app.post('/api/whatsapp/send', async (req, res) => {
    if (waStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    try {
        const { to, message } = req.body;
        if (!to || !message) return res.status(400).json({ error: 'Missing parameters' });

        // Format Chat ID
        let chatId = to;
        if (!chatId.includes('@g.us') && !chatId.includes('@c.us')) {
            chatId = `${to}@c.us`; // If it's a mobile number, append @c.us
        }

        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Send Error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// 4. Create Group Endpoint (NEW FOR ENTERPRISE AUTO-SETUP)
app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'WhatsApp not connected' });
    }

    try {
        const { groupName, participants } = req.body;
        
        if (!groupName || !participants || !Array.isArray(participants)) {
            return res.status(400).json({ error: 'Missing groupName or participants array' });
        }

        // Format participants to strictly use @c.us format
        const formattedParticipants = participants.map(p => {
            let num = String(p).replace(/[^0-9]/g, '');
            return `${num}@c.us`;
        });

        console.log(`Creating Group: "${groupName}" with ${formattedParticipants.length} members...`);
        
        // Execute Native Group Creation
        const response = await client.createGroup(groupName, formattedParticipants);
        
        // Return the newly created Group ID to frontend
        res.json({ success: true, groupId: response.gid._serialized });
    } catch (error) {
        console.error('Group Creation Error:', error);
        res.status(500).json({ error: 'Failed to create group. WhatsApp might have blocked additions.' });
    }
});

// 5. Read Acknowledgments Endpoint
app.get('/api/whatsapp/acks', (req, res) => {
    const data = [...ackQueue];
    ackQueue = []; // Clear after sending
    res.json(data);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🔥 PC SERVER IS RUNNING ON PORT ${PORT} 🔥`);
    console.log(`Waiting for WhatsApp Web to initialize...`);
    client.initialize();
});
