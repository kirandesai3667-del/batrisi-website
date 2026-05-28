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

// 🔥 SMART GROUP CREATOR WITH LIVE NUMBER VERIFICATION
app.post('/api/whatsapp/create-group', async (req, res) => {
    if (waStatus !== 'CONNECTED') return res.status(400).json({ error: 'WhatsApp not connected' });

    try {
        const { groupName, participants } = req.body;
        console.log(`\n================================================`);
        console.log(`🛠️ INITIATING GROUP CREATION: "${groupName}"`);

        if (!groupName || !participants || participants.length === 0) {
            console.log(`❌ No participants provided for this village.`);
            return res.status(400).json({ error: 'Missing Data' });
        }

        // Clean mobile numbers
        let validParticipants = [];
        for (let p of participants) {
            let num = String(p).replace(/[^0-9]/g, '');
            if (num.length >= 10) {
                if (!num.startsWith('91') && num.length === 10) num = '91' + num;
                validParticipants.push(`${num}@c.us`);
            }
        }

        let groupId = null;
        let createdMember = null;

        // LOOP: Find at least ONE valid WhatsApp user to create the group
        for (let i = 0; i < validParticipants.length; i++) {
            let testNum = validParticipants[i];
            console.log(`   ⏳ Testing member: ${testNum}`);
            
            try {
                // 1️⃣ CHECK IF NUMBER IS ON WHATSAPP FIRST!
                const isRegistered = await client.getNumberId(testNum);
                
                if (!isRegistered) {
                    console.log(`   ❌ Number not registered on WhatsApp. Skipping...`);
                    continue;
                }

                // 2️⃣ TRY CREATING THE GROUP
                const response = await client.createGroup(groupName, [isRegistered._serialized]);
                
                if (response && response.gid) {
                    groupId = response.gid._serialized;
                    createdMember = isRegistered._serialized;
                    console.log(`   ✅ SUCCESS! Group Created. ID: ${groupId}`);
                    break; // Stop looking, group is successfully created!
                }
            } catch (err) {
                console.log(`   ⚠️ Failed (Privacy Block). Trying next member...`);
            }
        }

        // Agar saare 200 members invalid nikle ya block karke baithe hain
        if (!groupId) {
            console.log(`❌ CRITICAL: Could not create group. All numbers failed or blocked it.`);
            return res.status(500).json({ error: 'WhatsApp rejected group creation.' });
        }

        // Admin Panel ko turant Success bhejo!
        res.json({ success: true, groupId: groupId });

        // 3️⃣ BACKGROUND TASK: Baaki members ko aaram se add karo
        let remainingPeople = validParticipants.filter(p => p !== createdMember);
        
        if (remainingPeople.length > 0) {
            setTimeout(async () => {
                console.log(`⏳ Background: Adding ${remainingPeople.length} members to "${groupName}"...`);
                try {
                    const chat = await client.getChatById(groupId);
                    
                    for (let i = 0; i < remainingPeople.length; i += 20) {
                        const chunk = remainingPeople.slice(i, i + 20); // 20 members at a time
                        
                        // Verification filter for batch
                        let finalChunk = [];
                        for(let num of chunk) {
                            const isReg = await client.getNumberId(num);
                            if(isReg) finalChunk.push(isReg._serialized);
                        }

                        if(finalChunk.length > 0) {
                            try {
                                await chat.addParticipants(finalChunk);
                                console.log(`   -> Added batch of ${finalChunk.length} members.`);
                            } catch(e) {
                                console.log(`   -> Some members in batch had privacy blocks. Skipped.`);
                            }
                        }
                        
                        // Wait 5 seconds before next batch
                        await new Promise(resolve => setTimeout(resolve, 5000));
                    }
                    console.log(`🎉 Finished adding all valid members to "${groupName}"!`);
                } catch(e) {
                    console.error("Background error:", e.message);
                }
            }, 3000);
        }

    } catch (error) {
        console.error('❌ Route Error:', error.message);
        res.status(500).json({ error: 'Failed to create group.' });
    }
});

// --- START SERVER ---
app.listen(PORT, () => {
    console.log(`🔥 PC SERVER IS RUNNING ON PORT ${PORT} 🔥`);
    client.initialize();
});
