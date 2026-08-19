import axios from 'axios';

export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let page = null;

    try {
        // 1. Lấy URL Douyin từ chuỗi nhập vào
        const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
        if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

        // 2. Lấy URL đầy đủ sau Redirect để trích xuất Video ID
        const redirectRes = await axios.get(urlMatch[0], {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' 
            },
            maxRedirects: 5,
            timeout: 8000
        });

        const finalUrl = redirectRes.request?.res?.responseUrl || redirectRes.config.url;
        const itemId = (finalUrl.match(/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/))?.[1];

        if (!itemId) throw new Error('Không bóc tách được Video ID!');

        // 3. Mở tab Puppeteer để lấy Cookie môi trường hợp lệ từ Douyin
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        
        // Điều hướng ngắn gọn để lấy Cookie Session
        await page.goto(`https://www.douyin.com/video/${itemId}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 10000 
        }).catch(() => {});

        // Lấy danh sách Cookie thu thập được từ Browser
        const cookies = await page.cookies();
        const cookieString = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        // Đóng tab ngay sau khi lấy được Cookie để giải phóng RAM
        await page.close();
        page = null;

        // 4. Gọi API Douyin bằng Axios ở môi trường Node.js (Tránh tuyệt đối lỗi Promise was collected)
        const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${itemId}&device_platform=webapp&aid=6383`;
        
        const apiRes = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
                'Cookie': cookieString,
                'Referer': `https://www.douyin.com/video/${itemId}`,
                'Accept': 'application/json'
            },
            timeout: 8000
        });

        const detail = apiRes.data?.aweme_detail;
        if (!detail) throw new Error('API Douyin không trả về dữ liệu video!');

        // 5. Trích xuất đường dẫn Video CDN
        const urlList = detail.video?.play_addr?.url_list || detail.video?.bit_rate?.[0]?.play_addr?.url_list || [];
        let videoUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0] || null;

        if (videoUrl) {
            videoUrl = videoUrl.replace('playwm', 'play').replace(/^http:/, 'https:');
        } else {
            throw new Error('Không tìm thấy luồng Video CDN!');
        }

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'douyin',
            data: {
                id: itemId,
                title: detail.desc || 'Video Douyin',
                cover: detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0] || null,
                author: detail.author?.nickname || 'Khách',
                videoUrl: videoUrl,
                musicUrl: detail.music?.play_url?.url_list?.[0] || null,
                images: detail.images?.map(img => img.url_list?.[0]) || []
            }
        };

    } catch (err) {
        throw new Error(err.message || 'Lỗi bóc tách Douyin');
    } finally {
        if (page) await page.close().catch(() => {});
    }
}