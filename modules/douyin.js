import axios from 'axios';

export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let page = null;

    try {
        // 1. Trích xuất URL Douyin từ chuỗi chia sẻ
        const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
        if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

        // 2. Lấy URL cuối cùng sau redirect để trích xuất Video ID
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

        // 3. Mở tab và truy cập trực tiếp trang video để tích lũy Cookie/Tokens tự động
        page = await browser.newPage();
        
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        });

        // Điều hướng trực tiếp tới trang video để Douyin khởi tạo Session/Cookie
        await page.goto(`https://www.douyin.com/video/${itemId}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 10000 
        }).catch(() => {});

        // 4. Gọi API lấy thông tin chi tiết ngay trong Context của trang
        const resultData = await page.evaluate(async (vId) => {
            try {
                const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
                const response = await fetch(apiUrl, { 
                    method: 'GET', 
                    credentials: 'include',
                    headers: {
                        'Accept': 'application/json',
                    }
                });
                
                const data = await response.json();
                const detail = data?.aweme_detail;
                if (!detail) return null;

                // Lấy danh sách URL Video
                const urlList = detail.video?.play_addr?.url_list || detail.video?.bit_rate?.[0]?.play_addr?.url_list || [];
                let videoUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0] || null;

                if (videoUrl) {
                    // Chuyển đổi link playwm -> play và ép HTTPS
                    videoUrl = videoUrl.replace('playwm', 'play').replace(/^http:/, 'https:');
                }

                return {
                    id: vId,
                    title: detail.desc || 'Video Douyin',
                    cover: detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0] || null,
                    author: detail.author?.nickname || 'Khách',
                    videoUrl: videoUrl,
                    musicUrl: detail.music?.play_url?.url_list?.[0] || null
                };
            } catch (e) {
                return null;
            }
        }, itemId);

        if (!resultData || !resultData.videoUrl) {
            throw new Error('Không bóc được luồng Video CDN từ trang!');
        }

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'douyin',
            data: resultData
        };

    } finally {
        if (page) await page.close().catch(() => {});
    }
}