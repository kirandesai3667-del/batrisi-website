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

// 🔥 SMART GROUP CREATOR WITH FALLBACK LOOP
app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { groupName, participants } = req.body;
        console.log(`\n================================================`);
        console.log(`🛠️ INITIATING GROUP CREATION: "${groupName}"`);

        if (!groupName || !participants || participants.length === 0) {
            console.log(`❌ No participants provided.`);
            return res.status(400).json({ error: 'Missing Data' });
        }

        // Clean numbers
        let validParticipants = [];
        for (let p of participants) {
            let num = String(p).replace(/[^0-9]/g, '');
            if (num.length >= 10) {
                if (!num.startsWith('91') && num.length === 10) num = '91' + num;
                validParticipants.push(`${num}@c.us`);
            }
        }

        // Remove bot's own number from list (if exists) to avoid errors
        const myNum = client.info.wid._serialized;
        validParticipants = validParticipants.filter(p => p !== myNum);

        let groupId = null;

        // LOOP: Find ONE valid user without a privacy block to create the group
        for (let i = 0; i < validParticipants.length; i++) {
            let testNum = validParticipants[i];
            console.log(`   ⏳ Trying to build group with member: ${testNum}`);
            
            try {
                const isReg = await client.getNumberId(testNum);
                if (!isReg) {
                    console.log(`   ❌ Not on WhatsApp. Skipping...`);
                    continue;
                }

                // TRY TO CREATE GROUP
                const response = await client.createGroup(groupName, [isReg._serialized]);
                
                if (response && response.gid) {
                    groupId = response.gid._serialized ? response.gid._serialized : response.gid;
                    console.log(`   ✅ SUCCESS! Group Created. ID: ${groupId}`);
                    
                    // Remove this person from the remaining list so we don't add them twice
                    validParticipants.splice(i, 1);
                    break;
                }
            } catch (err) {
                console.log(`   ⚠️ Failed (Privacy Block or Error). Trying next member...`);
            }
        }

        if (!groupId) {
            console.log(`❌ CRITICAL: Could not create group. All numbers failed or had privacy blocks.`);
            return res.status(500).json({ error: 'WhatsApp rejected group creation.' });
        }

        // ✅ Send Success to Admin Panel Instantly!
        res.json({ success: true, groupId: groupId });

        // ⚙️ BACKGROUND TASK: Add the rest of the members slowly in batches
        if (validParticipants.length > 0) {
            setTimeout(async () => {
                console.log(`⏳ Background: Adding ${validParticipants.length} remaining members to "${groupName}"...`);
                try {
                    const chat = await client.getChatById(groupId);
                    
                    // Batch logic: 15 members at a time
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
                                await chat.addParticipants(finalChunk);
                                console.log(`   -> Batch added ${finalChunk.length} members.`);
                            } catch(e) {
                                console.log(`   -> Some members in batch had privacy blocks. Skipped.`);
                            }
                        }
                        
                        // Wait 5 seconds before adding the next batch to bypass Anti-Ban limits
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    console.log(`🎉 Finished adding all valid members to "${groupName}"!`);
                } catch(e) {
                    console.error("Background error:", e.message);
                }
            }, 4000);
        }

    } catch (error) {
        console.error('❌ Route Error:', error.message);
        res.status(500).json({ error: 'Failed to create group.' });
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
    client.initialize();
});
