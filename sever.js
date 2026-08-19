import express from 'express';
import cors from 'cors';
import puppeteer from 'puppeteer';
import axios from 'axios';
import path from 'path';
import { fileURLToPath } from 'url';
import NodeCache from 'node-cache';
import rateLimit from 'express-rate-limit';

// Import các module bóc tách dữ liệu
import { parseDouyin } from './modules/douyin.js';
import { parseFacebook } from './modules/facebook.js';
import { parseTikTok } from './modules/tiktok.js';
import { parseYouTube } from './modules/youtube.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// ------------------------------------------------------------------
// CẤU HÌNH BẢO VỆ & TỐI ƯU HIỆU NĂNG
// ------------------------------------------------------------------

// 1. Lưu Cache kết quả bóc link trong 10 phút (600 giây) để tránh quá tải
const apiCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// 2. Chống Spam / DDOS (Chỉ cho phép tối đa 30 request bóc link / 1 phút mỗi IP)
const parseLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 30,
    message: { success: false, error: 'Bạn đã gửi quá nhiều yêu cầu. Vui lòng đợi 1 phút!' }
});

// Cấu hình Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

let browser = null;

/**
 * Khởi tạo trình duyệt Puppeteer tối ưu cho Docker / Render.com
 */
async function initBrowser() {
    if (!browser || !browser.isConnected()) {
        try {
            browser = await puppeteer.launch({
                headless: 'new',
                // Tự động sử dụng đường dẫn Chrome hệ thống nếu chạy trong Docker
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process', // Giảm chiếm dụng bộ nhớ RAM
                    '--disable-extensions',
                    '--blink-settings=imagesEnabled=false' // Không tải hình ảnh khi crawl
                ]
            });
            console.log('✅ Trình duyệt Puppeteer đã sẵn sàng.');
        } catch (err) {
            console.error('❌ Lỗi khởi tạo Puppeteer:', err.message);
        }
    }
    return browser;
}

// ------------------------------------------------------------------
// 1. API PARSE: Phân loại nền tảng & Bóc tách dữ liệu
// ------------------------------------------------------------------
app.post('/api/parse', parseLimiter, async (req, res) => {
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

        // 🌟 KIỂM TRA CACHE TRƯỚC KHI BÓC LINK (Tốc độ instant 0.01s)
        const cacheKey = `parse_${url}`;
        const cachedData = apiCache.get(cacheKey);
        if (cachedData) {
            console.log(`⚡ [CACHE HIT]: ${url}`);
            return res.json(cachedData);
        }

        let rawResult = null;
        const currentBrowser = await initBrowser();

        // Phân loại nền tảng và gọi module tương ứng
        if (url.includes('facebook.com') || url.includes('fb.watch') || url.includes('fb.gg')) {
            console.log(`📡 [FACEBOOK] Bóc link: ${url}`);
            rawResult = await parseFacebook(currentBrowser, url);
        } else if (url.includes('douyin.com')) {
            console.log(`📡 [DOUYIN] Bóc link: ${url}`);
            rawResult = await parseDouyin(currentBrowser, url);
        } else if (url.includes('tiktok.com') || url.includes('vt.tiktok.com')) {
            console.log(`📡 [TIKTOK] Bóc link: ${url}`);
            rawResult = await parseTikTok(currentBrowser, url);
        } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
            console.log(`📡 [YOUTUBE] Bóc link: ${url}`);
            rawResult = await parseYouTube(url);
        } else {
            return res.status(400).json({ 
                success: false, 
                error: 'Chỉ hỗ trợ bóc link từ YouTube, TikTok, Douyin và Facebook!' 
            });
        }

        if (!rawResult || !rawResult.data) {
            throw new Error('Không lấy được dữ liệu từ module bóc tách.');
        }

        const rawData = rawResult.data || {};
        const isImagePost = Array.isArray(rawData.images) && rawData.images.length > 0;

        // Chuẩn hóa danh sách chất lượng video
        const formatList = (rawData.streams?.combined || []).map(s => ({
            quality: s.quality,
            ext: s.ext,
            url: s.url
        }));

        if (formatList.length === 0 && rawData.directPlayUrl) {
            formatList.push({
                quality: '720p',
                ext: 'mp4',
                url: rawData.directPlayUrl
            });
        }

        // Chuẩn hóa tập dữ liệu phản hồi
        const cleanData = {
            id: rawData.id || '',
            title: rawData.title || 'Video',
            cover: rawData.cover || '',
            thumbnail: rawData.cover || '',
            author: rawData.author || '',
            durationSeconds: rawData.durationSeconds || 0,
            duration: rawData.durationSeconds || 0,
            viewCount: rawData.viewCount || 0,
            
            directPlayUrl: rawData.directPlayUrl || (formatList[0]?.url || ''),
            url: rawData.directPlayUrl || (formatList[0]?.url || ''),
            
            images: isImagePost ? rawData.images : [],
            
            qualityList: formatList,
            streams: formatList,
            formats: formatList,
            links: formatList,
            urls: formatList
        };

        const responsePayload = {
            success: true,
            processTime: rawResult.processTime || '1.0s',
            platform: rawResult.platform || 'unknown',
            type: isImagePost ? 'image' : 'video',
            data: cleanData
        };

        // 🌟 LƯU KẾT QUẢ VÀO CACHE TRƯỚC KHI TRẢ VỀ
        apiCache.set(cacheKey, responsePayload);

        return res.json(responsePayload);

    } catch (err) {
        console.error('❌ [PARSE ERROR DETAILS]:', err.stack || err.message || err);
        return res.status(500).json({ 
            success: false, 
            error: 'Không thể bóc tách dữ liệu từ liên kết này. Vui lòng thử lại sau!' 
        });
    }
});

// ------------------------------------------------------------------
// 2. API DOWNLOAD / STREAM PROXY (TỐI ƯU STREAM VÀ BĂNG THÔNG)
// ------------------------------------------------------------------
app.get('/api/download', async (req, res) => {
    let cancelTokenSource = axios.CancelToken.source();

    try {
        const { url, filename } = req.query;
        if (!url) return res.status(400).send('Thiếu tham số URL');

        const targetUrl = decodeURIComponent(url);

        // Đặt Header Referer tương ứng với từng nền tảng
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
            timeout: 30000,
            cancelToken: cancelTokenSource.token
        });

        // Tên file an toàn
        let safeFilename = filename ? decodeURIComponent(filename) : 'download_file.mp4';
        safeFilename = safeFilename.replace(/[/\\?%*:|"<>]/g, '_');
        const encodedFilename = encodeURIComponent(safeFilename);

        // Thiết lập Headers ép tải xuống
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        // Hủy Request Proxy nếu người dùng nhấn Stop/Đóng trình duyệt midway
        req.on('close', () => {
            cancelTokenSource.cancel('User aborted download.');
        });

        // Pipe dữ liệu trực tiếp tới Client
        response.data.pipe(res);

    } catch (err) {
        if (axios.isCancel(err)) {
            console.log('⚠️ [DOWNLOAD]: Người dùng đã ngắt kết nối giữa chừng.');
        } else {
            console.error('❌ [DOWNLOAD ERROR]:', err.message);
            if (!res.headersSent) {
                res.status(500).send('Không thể tải tệp tin này về máy.');
            }
        }
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