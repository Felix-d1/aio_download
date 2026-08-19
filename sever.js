import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

// Import các module bóc tách dữ liệu
import { parseDouyin } from './modules/douyin.js';
import { parseFacebook } from './modules/facebook.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

let browser = null;

// Khởi tạo trình duyệt Puppeteer dùng chung để tối ưu bộ nhớ RAM
async function initBrowser() {
    if (!browser) {
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--blink-settings=imagesEnabled=false' // Tắt tải ảnh không cần thiết để tăng tốc
                ]
            });
            console.log('✅ Trình duyệt ngầm Puppeteer đã khởi tạo thành công.');
        } catch (err) {
            console.error('❌ Lỗi khởi tạo Puppeteer:', err.message);
        }
    }
}

// ------------------------------------------------------------------
// 1. API PARSE: Tự động phân loại nền tảng và bóc tách dữ liệu
// ------------------------------------------------------------------
app.post('/api/parse', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'Vui lòng cung cấp URL!' });
        }

        // Trích xuất liên kết HTTP/HTTPS từ đoạn văn bản dán vào (chống dán lẫn văn bản)
        const matchUrl = url.match(/(https?:\/\/[^\s]+)/);
        if (matchUrl) {
            url = matchUrl[0];
        } else {
            return res.status(400).json({ success: false, error: 'Đường dẫn không hợp lệ!' });
        }

        if (!browser) await initBrowser();

        let result = null;

        // Tự động nhận diện nền tảng từ URL
        if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.gg')) {
            console.log(`📡 [FACEBOOK] Nhận yêu cầu bóc link: ${url}`);
            result = await parseFacebook(browser, url);
        } else if (url.includes('douyin.com')) {
            console.log(`📡 [DOUYIN] Nhận yêu cầu bóc link: ${url}`);
            result = await parseDouyin(browser, url);
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Hệ thống hiện tại hỗ trợ bóc link từ Douyin và Facebook!' 
            });
        }

        // Xác định kiểu nội dung là Bài đăng tập ảnh hay Video
        const isImagePost = result.data?.images && Array.isArray(result.data.images) && result.data.images.length > 0;

        return res.json({
            success: true,
            processTime: result.processTime || '0.5s',
            platform: result.platform || 'unknown',
            type: isImagePost ? 'image' : 'video',
            data: result.data
        });

    } catch (err) {
        console.error('❌ Lỗi bóc tách:', err.message);
        return res.status(500).json({ 
            success: false, 
            error: err.message || 'Không thể bóc tách dữ liệu từ liên kết này.' 
        });
    }
});

// ------------------------------------------------------------------
// 2. API DOWNLOAD PROXY: Tải file trung gian tránh lỗi CORS / Referer
// ------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
    try {
        const { url, filename } = req.query;
        if (!url) return res.status(400).send('Thiếu tham số URL');

        const targetUrl = decodeURIComponent(url);

        // Tự động điều chỉnh Referer tùy theo nền tảng nguồn
        let refererHeader = 'https://www.douyin.com/';
        if (targetUrl.includes('fbcdn.net') || targetUrl.includes('facebook.com')) {
            refererHeader = 'https://www.facebook.com/';
        }

        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': refererHeader
            },
            timeout: 30000
        });

        // Xử lý Content-Type và Filename phù hợp
        const contentType = response.headers['content-type'] || 'application/octet-stream';
        let safeFilename = filename ? decodeURIComponent(filename) : 'download_file';

        // Tự động điều chỉnh extension nếu là ảnh WebP
        if (contentType.includes('image/webp') && !safeFilename.endsWith('.webp')) {
            safeFilename = safeFilename.replace(/\.[^/.]+$/, "") + ".webp";
        }

        const encodedFilename = encodeURIComponent(safeFilename);

        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', contentType);

        response.data.pipe(res);
    } catch (err) {
        console.error('❌ Lỗi Proxy Download:', err.message);
        res.status(500).send('Không thể tải tài nguyên qua Proxy: ' + err.message);
    }
});

// ------------------------------------------------------------------
// Khởi chạy Server
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
    await initBrowser();
    console.log(`==================================================`);
    console.log(`🚀 AIO DOWNLOADER ENGINE IS RUNNING!`);
    console.log(`🔗 Web Interface: http://localhost:${PORT}`);
    console.log(`==================================================`);
});