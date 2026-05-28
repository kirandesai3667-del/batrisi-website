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

// 🔥 SMART GROUP CREATOR (Fix for Large Audience Crash)
app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { groupName, participants } = req.body;
        
        if (!groupName || !participants || participants.length === 0) {
            return res.status(400).json({ error: 'Missing groupName or participants' });
        }

        // 1. Clean numbers properly
        const validParticipants = [];
        for (let p of participants) {
            let num = String(p).replace(/[^0-9]/g, '');
            if (num.length >= 10) validParticipants.push(`${num}@c.us`);
        }

        if (validParticipants.length === 0) return res.status(400).json({ error: 'No valid numbers found' });

        console.log(`⚙️ Attempting to create Group: "${groupName}"...`);
        
        // 2. CREATE GROUP WITH ONLY 1 MEMBER FIRST (Safe Method)
        const firstPerson = [validParticipants[0]];
        const remainingPeople = validParticipants.slice(1);

        const response = await client.createGroup(groupName, firstPerson);
        
        if (!response || !response.gid) {
            throw new Error("WhatsApp blocked group creation.");
        }

        const groupId = response.gid._serialized;
        console.log(`✅ Group created successfully! ID: ${groupId}`);

        // 3. Return SUCCESS immediately to the frontend!
        res.json({ success: true, groupId: groupId });

        // 4. BACKGROUND TASK: Add remaining members in chunks of 30
        if (remainingPeople.length > 0) {
            setTimeout(async () => {
                try {
                    console.log(`⏳ Background: Adding ${remainingPeople.length} members to "${groupName}"...`);
                    const chat = await client.getChatById(groupId);
                    
                    const chunkSize = 30; // Max 30 at a time
                    for (let i = 0; i < remainingPeople.length; i += chunkSize) {
                        const chunk = remainingPeople.slice(i, i + chunkSize);
                        await chat.addParticipants(chunk);
                        console.log(`   -> Added chunk of ${chunk.length} members...`);
                        
                        // Wait 5 seconds before adding next batch to avoid ban
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    console.log(`🎉 Finished adding all valid members to "${groupName}"!`);
                } catch (addErr) {
                    console.error(`⚠️ Notice: Some members couldn't be added to "${groupName}" (Privacy settings or invalid numbers).`);
                }
            }, 4000); // Starts 4 seconds after group creation
        }

    } catch (error) {
        console.error('❌ Group Creation Error:', error.message);
        res.status(500).json({ error: 'Failed to create group. WhatsApp blocked the request.' });
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
