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
    console.log('✅ SERVER WORKING: WHATSAPP CONNECTED!');
    waStatus = 'CONNECTED';
    latestQR = null;
});

client.on('disconnected', (reason) => {
    console.log('🔴 WHATSAPP DISCONNECTED:', reason);
    waStatus = 'DISCONNECTED';
});

// --- API ENDPOINTS ---
app.get('/api/whatsapp/status', (req, res) => res.json({ status: waStatus }));

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
        let chatId = to;
        if (!chatId.includes('@g.us') && !chatId.includes('@c.us')) chatId = `${to}@c.us`; 
        const response = await client.sendMessage(chatId, message);
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        res.status(500).json({ error: 'Failed to send message' });
    }
});

// 🔥 NAYA FEATURE: Kisi bhi number ko Group me Add karein
app.post('/api/whatsapp/group/add', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    try {
        const { groupId, phone } = req.body;
        
        if (!groupId || !phone) return res.status(400).json({ error: 'Missing Data' });

        console.log(`\n⚙️ Adding ${phone} to Group ID: ${groupId}`);
        
        // Clean mobile number
        let num = String(phone).replace(/[^0-9]/g, '');
        if (num.length >= 10) {
            if (!num.startsWith('91') && num.length === 10) num = '91' + num;
            const finalNum = `${num}@c.us`;

            // Check if number exists on WhatsApp
            const isReg = await client.getNumberId(finalNum);
            if(!isReg) {
                console.log(`❌ Number not on WhatsApp.`);
                return res.status(400).json({ error: 'This number is not registered on WhatsApp.' });
            }

            // Get Chat and Add Participant
            const chat = await client.getChatById(groupId);
            await chat.addParticipants([isReg._serialized]);
            
            console.log(`✅ Member added successfully!`);
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Invalid mobile number length.' });
        }
    } catch (error) {
        console.error('❌ Failed to add member:', error.message);
        res.status(500).json({ error: 'Failed to add member. They might have privacy restrictions.' });
    }
});

app.get('/api/whatsapp/acks', (req, res) => {
    const data = [...ackQueue];
    ackQueue = []; 
    res.json(data);
});

app.listen(PORT, () => {
    console.log(`🔥 PC SERVER IS RUNNING ON PORT ${PORT} 🔥`);
    client.initialize();
});
