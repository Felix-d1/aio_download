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

// 1. Lưu Cache kết quả bóc link trong 10 phút (600 giây)
const apiCache = new NodeCache({ stdTTL: 600, checkperiod: 120 });

// 2. Chống Spam / DDOS (Tối đa 30 request / 1 phút)
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
                executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--no-first-run',
                    '--no-zygote',
                    '--single-process',
                    '--disable-extensions',
                    '--blink-settings=imagesEnabled=false'
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

        // Trích xuất liên kết HTTP/HTTPS chuẩn xác từ văn bản người dùng dán vào
        const matchUrl = url.match(/(https?:\/\/[^\s]+)/);
        if (matchUrl) {
            url = matchUrl[0];
        } else {
            return res.status(400).json({ success: false, error: 'Đường dẫn không hợp lệ!' });
        }

        // 🌟 KIỂM TRA CACHE TRƯỚC KHI BÓC LINK
        const cacheKey = `parse_${url}`;
        const cachedData = apiCache.get(cacheKey);
        if (cachedData) {
            console.log(`⚡ [CACHE HIT]: ${url}`);
            return res.json(cachedData);
        }

        let rawResult = null;
        const currentBrowser = await initBrowser();
        const lowerUrl = url.toLowerCase();

        // Nhận diện nền tảng
        if (lowerUrl.includes('facebook.com') || lowerUrl.includes('fb.watch') || lowerUrl.includes('fb.gg') || lowerUrl.includes('fb.com') || lowerUrl.includes('m.facebook.com')) {
            console.log(`📡 [FACEBOOK] Bóc link: ${url}`);
            rawResult = await parseFacebook(currentBrowser, url);
        } else if (lowerUrl.includes('douyin.com') || lowerUrl.includes('iesdouyin.com')) {
            console.log(`📡 [DOUYIN] Bóc link: ${url}`);
            rawResult = await parseDouyin(currentBrowser, url);
        } else if (lowerUrl.includes('tiktok.com') || lowerUrl.includes('vt.tiktok.com')) {
            console.log(`📡 [TIKTOK] Bóc link: ${url}`);
            rawResult = await parseTikTok(currentBrowser, url);
        } else if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
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

        // 🛠 FIX QUAN TRỌNG: Quét bổ sung biến `videoUrl` từ parseDouyin.js
        let formatList = [];

        if (Array.isArray(rawData.streams?.combined) && rawData.streams.combined.length > 0) {
            formatList = rawData.streams.combined.map(s => ({
                quality: s.quality || 'HD No Watermark',
                ext: s.ext || 'mp4',
                url: s.url,
                link: s.url
            }));
        } else if (Array.isArray(rawData.qualityList) && rawData.qualityList.length > 0) {
            formatList = rawData.qualityList.map(s => ({ ...s, link: s.url || s.link }));
        }

        // Bổ sung rawData.videoUrl vào danh sách quét fallback
        const fallbackVideoUrl = rawData.videoUrl || rawData.directPlayUrl || rawData.video || rawData.playUrl || rawData.play || rawData.nwm_video_url || rawData.url;

        if (formatList.length === 0 && fallbackVideoUrl && typeof fallbackVideoUrl === 'string') {
            formatList.push({
                quality: 'Tải Video HD (Không Logo)',
                ext: 'mp4',
                url: fallbackVideoUrl,
                link: fallbackVideoUrl
            });
        }

        const finalVideoUrl = formatList[0]?.url || fallbackVideoUrl || '';

        // Chuẩn hóa tập dữ liệu phản hồi phủ rộng mọi thuộc tính Frontend có thể đọc
        const cleanData = {
            id: rawData.id || '',
            title: rawData.title || 'Media Douyin',
            cover: rawData.cover || rawData.thumbnail || '',
            thumbnail: rawData.cover || rawData.thumbnail || '',
            author: rawData.author || rawData.nickname || 'Unknown',
            durationSeconds: rawData.durationSeconds || 0,
            duration: rawData.durationSeconds || 0,
            viewCount: rawData.viewCount || 0,
            
            // Link trực tiếp
            directPlayUrl: finalVideoUrl,
            url: finalVideoUrl,
            videoUrl: finalVideoUrl,
            musicUrl: rawData.musicUrl || null,
            
            // Danh sách Ảnh
            images: isImagePost ? rawData.images : [],
            
            // Phủ rộng toàn bộ tên mảng biến để khớp với mọi mã Frontend
            qualityList: formatList,
            streams: formatList,
            formats: formatList,
            links: formatList,
            urls: formatList,
            downloads: formatList,
            medias: formatList
        };

        const responsePayload = {
            success: true,
            processTime: rawResult.processTime || '1.0s',
            platform: rawResult.platform || 'douyin',
            type: isImagePost ? 'image' : 'video',
            data: cleanData
        };

        // LƯU KẾT QUẢ VÀO CACHE TRƯỚC KHI TRẢ VỀ
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
        let refererHeader = 'https://www.douyin.com/';
        if (targetUrl.includes('facebook.com') || targetUrl.includes('fbcdn.net')) {
            refererHeader = 'https://www.facebook.com/';
        } else if (targetUrl.includes('tiktok.com') || targetUrl.includes('tikwm.com')) {
            refererHeader = 'https://www.tiktok.com/';
        } else if (targetUrl.includes('youtube.com')) {
            refererHeader = 'https://www.youtube.com/';
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

        // Thiết lập Headers ép trình duyệt tải xuống
        res.setHeader('Content-Disposition', `attachment; filename="${encodedFilename}"; filename*=UTF-8''${encodedFilename}`);
        res.setHeader('Content-Type', 'application/octet-stream');
        
        if (response.headers['content-length']) {
            res.setHeader('Content-Length', response.headers['content-length']);
        }

        // Hủy Request Proxy nếu người dùng đóng trình duyệt giữa chừng
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