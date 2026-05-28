const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

let waStatus = 'DISCONNECTED'; 
let latestQR = null;
let ackQueue = []; 

// 🟢 FIX: Added webVersionCache to stop the "Execution context destroyed" Error
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
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

// --- WHATSAPP EVENT LISTENERS ---

client.on('qr', async (qr) => {
    console.log('🟡 New QR Code Generated. Please open Admin Panel to scan...');
    waStatus = 'QR_READY';
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

client.on('message_ack', (msg, ack) => {
    let statusText = '';
    if(ack === 2) statusText = 'delivered';
    if(ack === 3) statusText = 'read';
    
    if(statusText) {
        ackQueue.push({ to: msg.to, status: statusText });
        if(ackQueue.length > 50) ackQueue.shift();
    }
});

client.on('message', msg => {
    if(!msg.from.includes('@g.us')) {
        ackQueue.push({ to: msg.from, status: 'replied', text: msg.body });
        if(ackQueue.length > 50) ackQueue.shift();
    }
});

// --- API ENDPOINTS ---

app.get('/api/whatsapp/status', (req, res) => {
    res.json({ status: waStatus });
});

app.get('/api/whatsapp/qr.png', (req, res) => {
    if (waStatus === 'QR_READY' && latestQR) {
        res.setHeader('Content-Type', 'image/png');
        res.send(latestQR);
    } else {
        res.status(404).send('QR not available');
    }
});

app.post('/api/whatsapp/send', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { to, message } = req.body;
        if (!to || !message) return res.status(400).json({ error: 'Missing parameters' });

        let chatId = to;
        if (!chatId.includes('@g.us') && !chatId.includes('@c.us')) {
            chatId = `${to}@c.us`; 
        }

        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        console.error('Send Error:', error);
        res.status(500).json({ error: 'Failed to send message' });
    }
});

app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { groupName, participants } = req.body;
        
        if (!groupName || !participants || !Array.isArray(participants)) {
            return res.status(400).json({ error: 'Missing groupName or participants array' });
        }

        const formattedParticipants = participants.map(p => {
            let num = String(p).replace(/[^0-9]/g, '');
            return `${num}@c.us`;
        });

        console.log(`Creating Group: "${groupName}" with ${formattedParticipants.length} members...`);
        
        const response = await client.createGroup(groupName, formattedParticipants);
        res.json({ success: true, groupId: response.gid._serialized });
    } catch (error) {
        console.error('Group Creation Error:', error);
        res.status(500).json({ error: 'Failed to create group. WhatsApp might have blocked additions.' });
    }
});

app.get('/api/whatsapp/acks', (req, res) => {
    const data = [...ackQueue];
    ackQueue = []; 
    res.json(data);
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🔥 PC SERVER IS RUNNING ON PORT ${PORT} 🔥`);
    console.log(`Waiting for WhatsApp Web to initialize...`);
    client.initialize();
});
