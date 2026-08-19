import axios from 'axios';

/**
 * Bóc tách dữ liệu Douyin trực tiếp bằng API nội bộ của Douyin (Không dùng API bên thứ 3)
 */
export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let fetchPage = null;

    // 1. Trích xuất URL Douyin
    const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
    if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

    let targetUrl = urlMatch[0];
    let itemId = extractAwemeId(targetUrl);

    // 2. Giải mã URL ngắn (v.douyin.com) để lấy itemId nếu chưa có
    if (!itemId) {
        try {
            const redirectRes = await axios.get(targetUrl, {
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' 
                },
                maxRedirects: 5,
                timeout: 5000
            });
            const finalUrl = redirectRes.request?.res?.responseUrl || redirectRes.config?.url || '';
            itemId = extractAwemeId(finalUrl);
            if (finalUrl.startsWith('http')) targetUrl = finalUrl;
        } catch (e) {
            console.log('⚠️ Không thể giải mã URL bằng Axios, sẽ thử mở tab Puppeteer...');
        }
    }

    try {
        fetchPage = await browser.newPage();

        // Cấu hình Headers chuẩn như Trình duyệt thật để Douyin nhả Cookie ttwid
        await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await fetchPage.setExtraHTTPHeaders({
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'sec-ch-ua': '"Chromium";v="124", "Google Chrome";v="124"',
            'sec-ch-ua-platform': '"Windows"',
            'sec-fetch-dest': 'empty',
            'sec-fetch-mode': 'cors',
            'sec-fetch-site': 'same-origin'
        });

        // Mở trang chủ Douyin để Browser tự động lấy Cookie (ttwid) hợp lệ
        await fetchPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});

        let resultData = null;

        // BƯỚC 1: Gọi API ngầm nội bộ của Douyin (`aweme/v1/web/aweme/detail`)
        if (itemId) {
            resultData = await fetchPage.evaluate(async (vId) => {
                try {
                    const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
                    const r = await fetch(apiUrl, { 
                        method: 'GET', 
                        headers: { 'Accept': 'application/json' },
                        credentials: 'include' 
                    });
                    const data = await r.json();
                    const detail = data?.aweme_detail;
                    if (!detail) return null;

                    // A. Bóc tách Ảnh (Tập ảnh / Note)
                    let images = [];
                    if (detail.images && detail.images.length > 0) {
                        images = detail.images.map(img => {
                            const raw = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
                            return raw ? raw.replace(':q75.webp', ':q100.webp') : null;
                        }).filter(Boolean);
                    }

                    // B. Bóc tách Video (Quét sạch các vị trí chứa link CDN)
                    const videoObj = detail.video || {};
                    const urlList = videoObj.play_addr?.url_list || 
                                    videoObj.bit_rate?.[0]?.play_addr?.url_list || 
                                    videoObj.play_addr_h264?.url_list || [];

                    let rawVideoUrl = urlList.find(u => u.includes('zjcdn.com') || u.includes('douyinvod.com')) || urlList[0] || null;

                    // Thay thế playwm thành play để lấy video Không Logo
                    if (rawVideoUrl) {
                        rawVideoUrl = rawVideoUrl.replace('playwm', 'play');
                    }

                    // C. Cover
                    const cover = images.length > 0 
                        ? images[0] 
                        : (videoObj.cover?.url_list?.[0] || videoObj.origin_cover?.url_list?.[0] || null);

                    return {
                        id: vId,
                        title: detail.desc || 'Bài đăng Douyin',
                        cover: cover,
                        author: detail.author?.nickname || 'Douyin User',
                        videoUrl: rawVideoUrl,
                        images: images,
                        musicUrl: detail.music?.play_url?.url_list?.[0] || null
                    };
                } catch (e) {
                    return null;
                }
            }, itemId);
        }

        // BƯỚC 2: Fallback - Nếu API v1 trả về rỗng, điều hướng thẳng bài viết để đọc Script Data
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            console.log(`🌐 [DOUYIN] Fallback DOM: Truy cập trực tiếp -> ${targetUrl}`);
            await fetchPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

            const pageData = await fetchPage.evaluate(() => {
                try {
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        const content = script.innerText || script.textContent || '';
                        
                        if (content.includes('RENDER_DATA')) {
                            const decodedText = decodeURIComponent(content.replace(/.*?RENDER_DATA\s*=\s*/, '').trim());
                            const jsonData = JSON.parse(decodedText);
                            for (const k in jsonData) {
                                if (jsonData[k]?.awemeDetail) return jsonData[k].awemeDetail;
                                if (jsonData[k]?.noteDetail) return jsonData[k].noteDetail;
                            }
                        }

                        if (content.includes('awemeDetail') || content.includes('noteDetail')) {
                            const jsonMatch = content.match(/\{.*"awemeDetail".*\}/s) || content.match(/\{.*"noteDetail".*\}/s);
                            if (jsonMatch) {
                                const parsed = JSON.parse(jsonMatch[0]);
                                return parsed.awemeDetail || parsed.noteDetail || parsed;
                            }
                        }
                    }
                } catch (e) {}
                return null;
            });

            if (pageData) {
                resultData = formatParsedData(pageData);
            }
        }

        // Kiểm tra kết quả
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            throw new Error('Không bóc tách được Video hoặc Ảnh từ Douyin!');
        }

        // 🛠 FIX LỖI QUAN TRỌNG: Chuẩn hóa toàn bộ URL để Server & Frontend tải được
        resultData.videoUrl = fixUrl(resultData.videoUrl);
        resultData.cover = fixUrl(resultData.cover);
        resultData.musicUrl = fixUrl(resultData.musicUrl);
        resultData.images = resultData.images.map(fixUrl);

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'douyin',
            data: resultData
        };

    } finally {
        if (fetchPage) await fetchPage.close().catch(() => {});
    }
}

function extractAwemeId(url) {
    if (!url) return null;
    const match = url.match(/(?:video|note|slideshow|modal_id=)\/??(\d{18,20})/i) || url.match(/(\d{18,20})/);
    return match ? match[1] : null;
}

function formatParsedData(detail) {
    const vId = detail.aweme_id || detail.item_id || '';

    let images = [];
    if (detail.images && detail.images.length > 0) {
        images = detail.images.map(img => {
            const raw = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
            return raw ? raw.replace(':q75.webp', ':q100.webp') : null;
        }).filter(Boolean);
    }

    const videoObj = detail.video || {};
    const urlList = videoObj.play_addr?.url_list || videoObj.bit_rate?.[0]?.play_addr?.url_list || [];
    let videoUrl = urlList.find(u => u.includes('zjcdn.com') || u.includes('douyinvod.com')) || urlList[0] || null;
    if (videoUrl) {
        videoUrl = videoUrl.replace('playwm', 'play');
    }

    const cover = images.length > 0 
        ? images[0] 
        : (videoObj.cover?.url_list?.[0] || videoObj.origin_cover?.url_list?.[0] || null);

    return {
        id: vId,
        title: detail.desc || detail.title || 'Bài đăng Douyin',
        cover: cover,
        author: detail.author?.nickname || 'Douyin User',
        videoUrl: videoUrl,
        images: images,
        musicUrl: detail.music?.play_url?.url_list?.[0] || null
    };
}

// Bắt buộc chuyển // -> https:// để Server/Client không bị đứt link
function fixUrl(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('//')) return `https:${url}`;
    if (url.startsWith('http://')) return url.replace('http://', 'https://');
    return url;
}