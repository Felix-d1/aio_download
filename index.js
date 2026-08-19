import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import compression from 'compression';

// Import module xử lý Douyin riêng của bạn
import { parseDouyin } from './modules/douyin.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ==========================================
// 1. MIDDLEWARE TỐI ƯU & BẢO MẬT
// ==========================================
app.use(helmet({ contentSecurityPolicy: false }));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Giới hạn lượt gọi chống spam crash Chromium
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    message: { success: false, error: 'Hệ thống đang quá tải, vui lòng thử lại sau!' }
});
app.use('/api/', apiLimiter);

// ==========================================
// 2. KHỞI TẠO BROWSER ENGINE (PUPPETEER)
// ==========================================
let browser = null;

async function initBrowser() {
    if (!browser) {
        console.log('⏳ [AIO CORE] Khởi động Chromium Engine ngầm...');
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--blink-settings=imagesEnabled=false' // Tắt tải ảnh để tăng tốc độ bóc link
                ]
            });

            // Lắng nghe sự cố nếu Browser bị ngắt bất ngờ
            browser.on('disconnected', () => {
                console.log('⚠️ [AIO CORE] Browser đã bị đóng! Đang khởi động lại...');
                browser = null;
            });

            const initPage = await browser.newPage();
            await initPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
            console.log('🌐 [AIO CORE] Khởi tạo Session Douyin...');
            await initPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
            await initPage.close();
            console.log('✅ [AIO CORE] Nền tảng AIO Downloader Sẵn Sàng!\n');
        } catch (err) {
            console.error('❌ [AIO CORE] Lỗi khởi động Chromium:', err.message);
        }
    }
}

// ==========================================
// 3. ROUTE 1: PARSE LINK (Dùng Puppeteer + Module parseDouyin)
// ==========================================
app.post('/api/parse', async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ success: false, error: 'Chưa cung cấp đường dẫn!' });

    console.log(`\n📡 Nhận yêu cầu bóc link: ${url.substring(0, 60)}...`);

    try {
        // Tự động khởi tạo lại Trình duyệt nếu bị ngắt
        if (!browser) await initBrowser();

        let result = null;
        if (url.includes('douyin.com') || url.includes('v.douyin.com')) {
            result = await parseDouyin(browser, url);
        } else {
            throw new Error('Liên kết chưa được hỗ trợ!');
        }

        console.log(`⚡ Bóc link thành công (${result.processTime || ''}) | ID: ${result.data ? result.data.id : 'OK'}`);
        return res.json({ success: true, ...result });

    } catch (err) {
        console.log(`❌ Lỗi bóc link: ${err.message}`);
        return res.status(500).json({ success: false, error: err.message });
    }
});

// ==========================================
// 4. ROUTE 2: DOWNLOAD PROXY (Stream CDN với Referer Chuẩn)
// ==========================================
app.get('/api/download', async (req, res) => {
    const videoUrl = req.query.url;
    const filename = req.query.filename || `douyin_${Date.now()}.mp4`;

    if (!videoUrl) return res.status(400).send('Thiếu URL tài nguyên!');

    try {
        console.log(`⬇️ Đang Stream file về Client: ${filename}`);

        const response = await axios({
            method: 'GET',
            url: videoUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': 'https://www.douyin.com/'
            },
            timeout: 60000
        });

        const encodedFilename = encodeURIComponent(filename);
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', 'video/mp4');

        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        response.data.pipe(res);

    } catch (err) {
        console.log(`❌ Lỗi Proxy Download: ${err.message}`);
        if (!res.headersSent) {
            res.status(500).send('Không thể tải file video từ CDN Douyin.');
        }
    }
});

// ==========================================
// 5. MÁY CHỦ
// ==========================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initBrowser();
    console.log(`==================================================`);
    console.log(`🚀 AIO DOWNLOADER ENGINE IS RUNNING!`);
    console.log(`🔗 Web Interface: http://localhost:${PORT}`);
    console.log(`==================================================`);
});