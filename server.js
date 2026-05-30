const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = 3000;

app.use(cors());
// 🔥 Ye limit 50mb ki hai taaki 250+ numbers ek sath aane par crash na ho
app.use(express.json({ limit: '50mb' })); 

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

// 🔥 SMART BULK SYNC ENDPOINT (Ye route purane code me nahi tha, yahi error de raha tha!)
app.post('/api/whatsapp/group/bulk-add', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    
    try {
        const { groupName, phones } = req.body;
        if (!groupName || !phones || !Array.isArray(phones)) return res.status(400).json({ error: 'Missing Data' });

        console.log(`\n🔍 Received Request to sync members to: "${groupName}"`);
        
        // FRONTEND KO TURANT JAWAB DE DO TAAKI NETWORK ERROR NA AAYE
        res.json({ success: true, message: "Processing started in background" });

        // BACKGROUND ME ARAM SE ADD KARO
        setTimeout(async () => {
            try {
                const chats = await client.getChats();
                const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
                
                if(!group) {
                    console.log(`❌ Group "${groupName}" not found on your phone! Check spelling.`);
                    return;
                }

                console.log(`✅ Group Found! Filtering ${phones.length} valid WhatsApp numbers...`);
                let validParticipants = [];
                
                for(let phone of phones) {
                    let num = String(phone).replace(/[^0-9]/g, '');
                    if (num.length >= 10) {
                        if (!num.startsWith('91') && num.length === 10) num = '91' + num;
                        validParticipants.push(`${num}@c.us`);
                    }
                }

                console.log(`✅ Ready to add members. Adding them safely in batches...`);
                
                for (let i = 0; i < validParticipants.length; i += 15) {
                    const chunk = validParticipants.slice(i, i + 15);
                    
                    let finalChunk = [];
                    for(let num of chunk) {
                        try {
                            const isReg = await client.getNumberId(num);
                            if(isReg) finalChunk.push(isReg._serialized);
                        } catch(e) {}
                    }

                    if(finalChunk.length > 0) {
                        try {
                            await group.addParticipants(finalChunk);
                            console.log(`   -> Added batch of ${finalChunk.length} members...`);
                        } catch (e) {
                            console.log(`   -> Some members skipped (Privacy limits).`);
                        }
                    }
                    await new Promise(r => setTimeout(r, 5000));
                }
                console.log(`🎉 SUCCESS: Fully synced all possible members to "${groupName}"!`);
            } catch(e) {
                console.log("Background error:", e.message);
            }
        }, 500);

    } catch (error) {
        console.error('❌ Route Error:', error.message);
    }
});

// SEND MESSAGE DIRECTLY TO GROUP
app.post('/api/whatsapp/group/send', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    try {
        const { groupName, message } = req.body;
        if (!groupName || !message) return res.status(400).json({ error: 'Missing Data' });

        console.log(`\n📨 Sending message to Group: "${groupName}"...`);
        const chats = await client.getChats();
        const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
        
        if(!group) return res.status(404).json({ error: `Group "${groupName}" not found on your phone. Check spelling.` });

        const response = await client.sendMessage(group.id._serialized, message);
        console.log(`✅ Message sent to group!`);
        res.json({ success: true, messageId: response.id.id });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
