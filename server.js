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

client.on('qr', async (qr) => {
    console.log('🟡 New QR Code Generated. Please scan from Admin Panel...');
    waStatus = 'QR_READY';
    latestQR = await qrcode.toBuffer(qr, { type: 'png' });
});

client.on('ready', () => {
    console.log('✅ SERVER READY: WHATSAPP IS CONNECTED!');
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

// INDIVIDUAL BROADCAST ENDPOINT
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

// 🔥 MISSING FEATURE ADDED: SMART BULK SYNC MEMBERS TO EXISTING GROUP
app.post('/api/whatsapp/group/bulk-add', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    
    try {
        const { groupName, phones } = req.body;
        if (!groupName || !phones || !Array.isArray(phones)) return res.status(400).json({ error: 'Missing Data' });

        console.log(`\n🔍 Searching for Group: "${groupName}"...`);
        const chats = await client.getChats();
        
        // Exact name match (ignores casing and extra spaces)
        const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
        
        if(!group) {
            console.log(`❌ Group not found!`);
            return res.status(404).json({ error: `Group "${groupName}" not found on your phone. Please check spelling.` });
        }

        console.log(`✅ Group Found! Starting background sync...`);
        
        // Return Success immediately so frontend Button turns Green
        res.json({ success: true, message: "Processing started in background" });

        // Background me dheere-dheere add karega taki WhatsApp ban na kare
        setTimeout(async () => {
            let validParticipants = [];
            
            // Clean numbers
            for(let phone of phones) {
                let num = String(phone).replace(/[^0-9]/g, '');
                if (num.length >= 10) {
                    if (!num.startsWith('91') && num.length === 10) num = '91' + num;
                    try {
                        const isReg = await client.getNumberId(`${num}@c.us`);
                        if(isReg) validParticipants.push(isReg._serialized);
                    } catch(e) {}
                }
            }

            console.log(`✅ Verified ${validParticipants.length} valid WhatsApp numbers. Syncing to group...`);
            
            // Chunks me add karo (15 logo ko ek baar me)
            for (let i = 0; i < validParticipants.length; i += 15) {
                const chunk = validParticipants.slice(i, i + 15);
                try {
                    await group.addParticipants(chunk);
                    console.log(`   -> Batch added ${chunk.length} members.`);
                } catch (e) {
                    console.log(`   -> Some members skipped (Privacy blocks or already in group).`);
                }
                await new Promise(r => setTimeout(r, 5000)); // Har 15 ke baad 5 sec rest
            }
            console.log(`🎉 SUCCESS: Finished syncing all members to "${groupName}"!`);
        }, 2000);

    } catch (error) {
        console.error('❌ Bulk Add Error:', error.message);
        if(!res.headersSent) res.status(500).json({ error: 'Failed to process request.' });
    }
});

// 🔥 SEND MESSAGE TO EXACT GROUP NAME
app.post('/api/whatsapp/group/send', async (re
