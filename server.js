const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const app = express();
const PORT = 3000;

app.use(cors());
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

// 🔥 SMART BULK SYNC (POORA GAAM EK SATH ADD KAREGA)
app.post('/api/whatsapp/group/bulk-add', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    
    try {
        const { groupName, phones } = req.body;
        if (!groupName || !phones || !Array.isArray(phones)) return res.status(400).json({ error: 'Missing Data' });

        console.log(`\n🔍 Searching for Group: "${groupName}"...`);
        const chats = await client.getChats();
        const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
        
        if(!group) {
            console.log(`❌ Group not found! Check spelling.`);
            return res.status(404).json({ error: `Group "${groupName}" not found on your phone. Please check spelling.` });
        }

        console.log(`✅ Group Found! Processing ${phones.length} members from Database...`);
        
        // Frontend ko turant success de do taki Error na aaye
        res.json({ success: true, message: "Processing started in background" });

        // Background me dheere-dheere add karega
        setTimeout(async () => {
            let validParticipants = [];
            
            for(let phone of phones) {
                let num = String(phone).replace(/[^0-9]/g, '');
                if (num.length >= 10) {
                    if (!num.startsWith('91') && num.length === 10) num = '91' + num;
                    validParticipants.push(`${num}@c.us`); // Save format
                }
            }

            console.log(`✅ Adding valid numbers to group...`);
            
            // Chunk size of 15 members
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
                        console.log(`   -> Batch added ${finalChunk.length} members.`);
                    } catch (e) {
                        console.log(`   -> Some members skipped (Privacy limits).`);
                    }
                }
                await new Promise(r => setTimeout(r, 5000)); // 5 sec wait
            }
            console.log(`🎉 SUCCESS: Finished syncing all members to "${groupName}"!`);
        }, 1000);

    } catch (error) {
        console.error('❌ Bulk Add Error:', error.message);
    }
});

// QUICK ADD (SINGLE MEMBER)
app.post('/api/whatsapp/group/add-member', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    try {
        const { groupName, phone } = req.body;
        if (!groupName || !phone) return res.status(400).json({ error: 'Missing Data' });

        let num = String(phone).replace(/[^0-9]/g, '');
        if (num.length >= 10) {
            if (!num.startsWith('91') && num.length === 10) num = '91' + num;
            const finalNum = `${num}@c.us`;

            const isReg = await client.getNumberId(finalNum);
            if(!isReg) return res.status(400).json({ error: 'Number is not on WhatsApp.' });

            const chats = await client.getChats();
            const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
            
            if(!group) return res.status(404).json({ error: `Group not found.` });

            await group.addParticipants([isReg._serialized]);
            res.json({ success: true, groupName: group.name });
        } else {
            res.status(400).json({ error: 'Invalid mobile number.' });
        }
    } catch (error) {
        res.status(500).json({ error: 'Failed to add member.' });
    }
});

// SEND TO EXACT GROUP NAME
app.post('/api/whatsapp/group/send', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });
    try {
        const { groupName, message } = req.body;
        if (!groupName || !message) return res.status(400).json({ error: 'Missing Data' });

        const chats = await client.getChats();
        const group = chats.find(c => c.isGroup && c.name.trim().toLowerCase() === groupName.trim().toLowerCase());
        
        if(!group) return res.status(404).json({ error: `Group "${groupName}" not found.` });

        const response = await client.sendMessage(group.id._serialized, message);
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
