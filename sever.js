import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';

// Import các module bóc tách dữ liệu
import { parseDouyin } from './modules/douyin.js';
import { parseFacebook } from './modules/facebook.js';
import { parseTikTok } from './modules/tiktok.js';
import { parseYouTube } from './modules/youtube.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Cấu hình Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let browser = null;

/**
 * Khởi tạo trình duyệt Puppeteer ngầm khi cần
 */
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
                    '--blink-settings=imagesEnabled=false'
                ]
            });
            console.log('✅ Trình duyệt ngầm Puppeteer đã khởi tạo thành công.');
        } catch (err) {
            console.error('❌ Lỗi khởi tạo Puppeteer:', err.message);
        }
    }
}

// ------------------------------------------------------------------
// 1. API PARSE: Phân loại nền tảng & Bóc tách dữ liệu
// ------------------------------------------------------------------
app.post('/api/parse', async (req, res) => {
    try {
        let { url } = req.body;
        if (!url) {
            return res.status(400).json({ success: false, error: 'Vui lòng cung cấp URL!' });
        }

        // Trích xuất liên kết HTTP/HTTPS từ đoạn văn bản người dùng dán vào
        const matchUrl = url.match(/(https?:\/\/[^\s]+)/);
        if (matchUrl) {
            url = matchUrl[0];
        } else {
            return res.status(400).json({ success: false, error: 'Đường dẫn không hợp lệ!' });
        }

        let rawResult = null;

        // Phân loại nền tảng và gọi module tương ứng
        if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.gg')) {
            if (!browser) await initBrowser();
            console.log(`📡 [FACEBOOK] Bóc link: ${url}`);
            rawResult = await parseFacebook(browser, url);
        } else if (url.includes('douyin.com')) {
            if (!browser) await initBrowser();
            console.log(`📡 [DOUYIN] Bóc link: ${url}`);
            rawResult = await parseDouyin(browser, url);
        } else if (url.includes('tiktok.com') || url.includes('vt.tiktok.com')) {
            if (!browser) await initBrowser();
            console.log(`📡 [TIKTOK] Bóc link: ${url}`);
            rawResult = await parseTikTok(browser, url);
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log(`📡 [YOUTUBE] Bóc link (yt-dlp/API): ${url}`);
            rawResult = await parseYouTube(url);
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Chỉ hỗ trợ bóc link từ YouTube, TikTok, Douyin và Facebook!' 
            });
        }

        const rawData = rawResult.data || {};
        const isImagePost = Array.isArray(rawData.images) && rawData.images.length > 0;

        // 🌟 Chuẩn hóa danh sách chất lượng video
        const formatList = (rawData.streams?.combined || []).map(s => ({
            quality: s.quality,
            ext: s.ext,
            url: s.url
        }));

        // Nếu danh sách rỗng nhưng có link directPlayUrl -> Ép tạo 1 item mặc định
        if (formatList.length === 0 && rawData.directPlayUrl) {
            formatList.push({
                quality: '720p',
                ext: 'mp4',
                url: rawData.directPlayUrl
            });
        }

        // 🌟 TẠO TẬP DỮ LIỆU TƯƠNG THÍCH ĐA NĂNG
        const cleanData = {
            id: rawData.id || '',
            title: rawData.title || 'Video',
            cover: rawData.cover || '',
            thumbnail: rawData.cover || '',
            author: rawData.author || '',
            durationSeconds: rawData.durationSeconds || 0,
            duration: rawData.durationSeconds || 0,
            viewCount: rawData.viewCount || 0,
            
            // Link direct phát video
            directPlayUrl: rawData.directPlayUrl || (formatList[0]?.url || ''),
            url: rawData.directPlayUrl || (formatList[0]?.url || ''),
            
            // Ảnh (dành cho album ảnh Douyin / TikTok)
            images: isImagePost ? rawData.images : [],
            
            // Ép tất cả các biến chứa danh sách link về cùng 1 mảng
            qualityList: formatList,
            streams: formatList,
            formats: formatList,
            links: formatList,
            urls: formatList
        };

        return res.json({
            success: true,
            processTime: rawResult.processTime || '1.0s',
            platform: rawResult.platform || 'youtube',
            type: isImagePost ? 'image' : 'video',
            data: cleanData
        });

    } catch (err) {
        console.error('❌ [PARSE ERROR DETAILS]:', err.stack || err.message || err);
        return res.status(500).json({ 
            success: false, 
            error: 'Không thể bóc tách dữ liệu từ liên kết này. Vui lòng thử lại sau!' 
        });
    }
});

// ------------------------------------------------------------------
// 2. API DOWNLOAD / STREAM PROXY (ĐÃ FIX TẢI FILE TRỰC TIẾP 100%)
// ------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
    try {
        const { url, filename } = req.query;
        if (!url) return res.status(400).send('Thiếu tham số URL');

        const targetUrl = decodeURIComponent(url);

        // Đặt Header Referer cho phù hợp từng nền tảng
        let refererHeader = 'https://www.youtube.com/';
        if (targetUrl.includes('douyin.com')) {
            refererHeader = 'https://www.douyin.com/';
        } else if (targetUrl.includes('fbcdn.net') || targetUrl.includes('facebook.com')) {
            refererHeader = 'https://www.facebook.com/';
        } else if (targetUrl.includes('tiktok.com') || targetUrl.includes('tikwm.com')) {
            refererHeader = 'https://www.tiktok.com/';
        }

        // Tải Stream từ link nguồn qua Server Proxy
        const response = await axios({
            method: 'get',
            url: targetUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Referer': refererHeader
            },
            timeout: 60000
        });

        // Xác định tên tệp tin tải về
        let safeFilename = filename ? decodeURIComponent(filename) : 'download_file.mp4';
        
        // Loại bỏ các ký tự đặc biệt nguy hiểm khỏi tên file
        safeFilename = safeFilename.replace(/[/\\?%*:|"<>]/g, '_');

        const encodedFilename = encodeURIComponent(safeFilename);

        // 🌟 BẮT BUỘC: Các Header này ÉP trình duyệt PHẢI TẢI XUỐNG FILE thay vì phát trực tuyến
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        // Pipe dữ liệu luồng trực tiếp tới trình duyệt người dùng
        response.data.pipe(res);

    } catch (err) {
        console.error('❌ [DOWNLOAD ERROR DETAILS]:', err.message);
        res.status(500).send('Không thể tải tệp tin này về máy.');
    }
});

// ------------------------------------------------------------------
// Khởi chạy Server
// ------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`==================================================`);
    console.log(`🚀 AIO DOWNLOADER ENGINE IS RUNNING!`);
    console.log(`🔗 Web Interface: http://localhost:${PORT}`);
    console.log(`==================================================`);
});