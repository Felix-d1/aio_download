import axios from 'axios';

export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let page = null;

    try {
        // 1. Trích xuất URL từ chuỗi chia sẻ
        const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
        if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

        // 2. Lấy Video ID bằng Mobile User-Agent
        const redirectRes = await axios.get(urlMatch[0], {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1' 
            },
            maxRedirects: 5,
            timeout: 8000
        });

        const finalUrl = redirectRes.request?.res?.responseUrl || redirectRes.config.url;
        const itemId = (finalUrl.match(/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/))?.[1];

        if (!itemId) throw new Error('Không bóc tách được Video ID!');

        // 3. CÁCH 1: Gọi API Mobile trực tiếp qua Axios (Bypass IP Datacenter Render)
        try {
            const mobileApiUrl = `https://www.iesdouyin.com/web/api/v2/aweme/iteminfo/?item_ids=${itemId}`;
            const apiRes = await axios.get(mobileApiUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1'
                },
                timeout: 5000
            });

            const item = apiRes.data?.item_list?.[0];
            if (item) {
                let videoUrl = item.video?.play_addr?.url_list?.[0];
                if (videoUrl) {
                    videoUrl = videoUrl.replace('playwm', 'play').replace(/^http:/, 'https:');
                    return {
                        processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
                        platform: 'douyin',
                        data: {
                            id: itemId,
                            title: item.desc || 'Video Douyin',
                            cover: item.video?.cover?.url_list?.[0] || null,
                            author: item.author?.nickname || 'Khách',
                            videoUrl: videoUrl,
                            musicUrl: item.music?.play_url?.url_list?.[0] || null
                        }
                    };
                }
            }
        } catch (e) {
            // Nếu API Mobile không khả dụng, chuyển sang dùng Puppeteer Fallback
        }

        // 4. CÁCH 2: Fallback qua Puppeteer (Nếu Cách 1 không trả về kết quả)
        page = await browser.newPage();
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await page.setExtraHTTPHeaders({ 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' });

        await page.goto(`https://www.douyin.com/video/${itemId}`, { 
            waitUntil: 'domcontentloaded', 
            timeout: 12000 
        }).catch(() => {});

        const resultData = await page.evaluate(async (vId) => {
            try {
                const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
                const response = await fetch(apiUrl, { headers: { 'Accept': 'application/json' } });
                const data = await response.json();
                const detail = data?.aweme_detail;
                if (!detail) return null;

                const urlList = detail.video?.play_addr?.url_list || detail.video?.bit_rate?.[0]?.play_addr?.url_list || [];
                let vUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0] || null;

                if (vUrl) {
                    vUrl = vUrl.replace('playwm', 'play').replace(/^http:/, 'https:');
                }

                return {
                    id: vId,
                    title: detail.desc || 'Video Douyin',
                    cover: detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0] || null,
                    author: detail.author?.nickname || 'Khách',
                    videoUrl: vUrl,
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