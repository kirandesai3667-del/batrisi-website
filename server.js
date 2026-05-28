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

// 🔥 ADVANCED SMART GROUP CREATOR (Bypasses Privacy Blockers)
app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { groupName, participants } = req.body;
        if (!groupName || !participants || participants.length === 0) {
            return res.status(400).json({ error: 'Missing Data' });
        }

        const validParticipants = participants.map(p => `${String(p).replace(/[^0-9]/g, '')}@c.us`);

        console.log(`\n⚙️ Attempting to create Group: "${groupName}"...`);
        
        let groupId = null;
        let created = false;
        let usedIndex = 0;

        // Try creating group with up to 10 different people (in case early ones have Privacy Blockers)
        for (let i = 0; i < Math.min(10, validParticipants.length); i++) {
            try {
                console.log(`   -> Trying to create with member: ${validParticipants[i]}`);
                const response = await client.createGroup(groupName, [validParticipants[i]]);
                
                if (response && response.gid) {
                    groupId = response.gid._serialized;
                    created = true;
                    usedIndex = i;
                    console.log(`   ✅ Success! Group ID: ${groupId}`);
                    break; // Stop loop, group is created!
                }
            } catch (err) {
                console.log(`   ⚠️ Failed (Privacy Block/Invalid). Trying next member...`);
            }
        }

        if (!created || !groupId) {
            console.log(`❌ CRITICAL: Could not create group. First 10 members blocked it.`);
            return res.status(500).json({ error: 'Failed. All tested members have privacy locks.' });
        }

        // Return SUCCESS to HTML frontend instantly
        res.json({ success: true, groupId: groupId });

        // BACKGROUND TASK: Add the rest of the members slowly
        let remainingPeople = validParticipants.filter((_, index) => index !== usedIndex);
        
        if (remainingPeople.length > 0) {
            setTimeout(async () => {
                console.log(`⏳ Background: Adding ${remainingPeople.length} remaining members to "${groupName}"...`);
                try {
                    const chat = await client.getChatById(groupId);
                    const chunkSize = 25; // Add 25 people at a time to be ultra-safe
                    
                    for (let i = 0; i < remainingPeople.length; i += chunkSize) {
                        const chunk = remainingPeople.slice(i, i + chunkSize);
                        try {
                            await chat.addParticipants(chunk);
                            console.log(`   -> Batch added ${chunk.length} members successfully.`);
                        } catch(chunkErr) {
                            console.log(`   -> Some members in this batch had privacy locks, skipping them.`);
                        }
                        // 5 second delay between batches
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    console.log(`🎉 Finished background adding for "${groupName}"!`);
                } catch(e) {
                    console.error("Background chunk error:", e.message);
                }
            }, 3000);
        }

    } catch (error) {
        res.status(500).json({ error: 'Failed to create group.' });
    }
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🔥 PC SERVER IS RUNNING ON PORT ${PORT} 🔥`);
    client.initialize();
});
