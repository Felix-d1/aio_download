import puppeteer from 'puppeteer';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import readline from 'readline';

const OUTPUT_DIR = './downloads';
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

let browser = null;

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\n📱 Nhập link Douyin (hoặc "exit" để thoát): '
});

console.log('==================================================');
console.log('🚀 ULTRA-FAST DOUYIN DOWNLOADER (STABLE CONTEXT)');
console.log('   (Sửa lỗi Execution Context | Tốc độ cao | Tải mượt)');
console.log('==================================================\n');

async function initBrowser() {
    if (!browser) {
        console.log('⏳ [SYSTEM] Khởi động Chromium Core...');
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

        // Mở 1 tab mồi để khởi tạo Cookie Session toàn cục
        const initPage = await browser.newPage();
        await initPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        console.log('🌐 [SYSTEM] Khởi tạo Session Douyin...');
        await initPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
        await initPage.close(); // Đóng tab mồi, Cookie đã lưu vào Browser Context
        console.log('✅ [SYSTEM] Hệ thống đã sẵn sàng!\n');
    }
}

await initBrowser();
rl.prompt();

rl.on('line', async (input) => {
    const line = input.trim();

    if (line.toLowerCase() === 'exit' || line.toLowerCase() === 'quit') {
        if (browser) await browser.close();
        rl.close();
        process.exit(0);
    }

    if (!line) {
        console.log('⚠️ Chưa nhập link!\n');
        rl.prompt();
        return;
    }

    const urlMatch = line.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
    if (!urlMatch) {
        console.log('❌ Không tìm thấy URL hợp lệ!\n');
        rl.prompt();
        return;
    }

    await ultraFastDownload(urlMatch[0]);
    rl.prompt();
});

async function ultraFastDownload(shareUrl) {
    const startTime = Date.now();
    console.log(`\n--- ⚙️ BẮT ĐẦU XỬ LÝ SIÊU TỐC ---`);

    try {
        // STEP 1: Giải mã Link lấy Video ID bằng Axios
        const redirectRes = await axios.get(shareUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            maxRedirects: 5,
            timeout: 5000
        });

        const finalUrl = redirectRes.request.res.responseUrl || redirectRes.config.url;
        const itemId = (finalUrl.match(/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/))?.[1];

        if (!itemId) throw new Error('Không bóc tách được Video ID!');
        
        const idTime = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`⚡ Video ID: ${itemId} (Bóc ID: ${idTime}s)`);

        // STEP 2: Tạo tab cách ly tạm thời để tránh đụng độ Navigation
        console.log('📡 Đang truy vấn Direct Stream CDN...');
        
        let cdnVideoUrl = null;
        let attempts = 0;

        while (!cdnVideoUrl && attempts < 2) {
            attempts++;
            let fetchPage = null;
            try {
                fetchPage = await browser.newPage();
                await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

                // Mở trang trắng cùng origin để fetch không bị chặn CORS
                await fetchPage.goto('https://www.douyin.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});

                cdnVideoUrl = await fetchPage.evaluate(async (vId) => {
                    try {
                        const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
                        const res = await fetch(apiUrl, { method: 'GET', credentials: 'include' });
                        const data = await res.json();
                        
                        const urlList = data?.aweme_detail?.video?.play_addr?.url_list;
                        if (urlList && urlList.length > 0) {
                            return urlList.find(u => u.includes('zjcdn.com')) || urlList[0];
                        }
                    } catch (e) {
                        return null;
                    }
                    return null;
                }, itemId);

            } catch (e) {
                // Nếu dính lỗi context thì thử lại lần 2
            } finally {
                if (fetchPage) await fetchPage.close().catch(() => {});
            }
        }

        if (!cdnVideoUrl) throw new Error('Không thể lấy được luồng Video CDN.');

        cdnVideoUrl = cdnVideoUrl.replace('playwm', 'play');
        const parseTime = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log(`✅ [SUCCESS] Bóc thành công CDN Video trong ${parseTime}s!`);

        // STEP 3: Tải Stream Video bằng Axios
        console.log(`\n--- ⬇️ BẮT ĐẦU TẢI STREAM ---`);
        const OUTPUT_FILE = path.join(OUTPUT_DIR, `douyin_${itemId}.mp4`);

        const dlStart = Date.now();
        const videoStream = await axios({
            method: 'GET',
            url: cdnVideoUrl,
            responseType: 'stream',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Referer': 'https://www.douyin.com/'
            },
            timeout: 60000
        });

        const writer = fs.createWriteStream(OUTPUT_FILE);
        videoStream.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        const dlTime = ((Date.now() - dlStart) / 1000).toFixed(2);
        const stats = fs.statSync(OUTPUT_FILE);
        const sizeMB = (stats.size / 1024 / 1024).toFixed(2);

        console.log(`🎉 --- TẢI HOÀN TẤT ---`);
        console.log(`⏱️ Thời gian: Bóc link (${parseTime}s) + Tải file (${dlTime}s) = Tổng (${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
        console.log(`📁 File: ${OUTPUT_FILE}`);
        console.log(`📏 Dung lượng: ${sizeMB} MB\n`);

    } catch (err) {
        console.log(`❌ [LỖI]: ${err.message}\n`);
    }
}