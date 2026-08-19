import axios from 'axios';

/**
 * Hàm bóc tách dữ liệu Douyin (Video / Slide ảnh / Audio)
 * @param {import('puppeteer').Browser} browser Instance của Puppeteer
 * @param {string} shareUrl URL dán từ người dùng
 */
export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let fetchPage = null;

    // 1. Trích xuất URL Douyin từ văn bản người dùng nhập
    const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
    if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

    let targetUrl = urlMatch[0];
    let itemId = extractAwemeId(targetUrl);

    // 2. Giải mã URL nếu người dùng gửi link ngắn (v.douyin.com / iesdouyin.com)
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
            console.log('⚠️ Không thể giải mã URL bằng Axios, sẽ chuyển tiếp qua Puppeteer...');
        }
    }

    try {
        fetchPage = await browser.newPage();
        
        // Giả lập Headers chuẩn trình duyệt PC để qua mặt Cloudflare/Anti-bot
        await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');
        await fetchPage.setExtraHTTPHeaders({
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'sec-ch-ua': '"Not-A.Brand";v="99", "Chromium";v="124", "Google Chrome";v="124"',
            'sec-ch-ua-platform': '"Windows"'
        });

        // Bắt thêm Network Sniffer dự phòng CDN ảnh
        const capturedImages = new Set();
        fetchPage.on('response', response => {
            const resUrl = response.url();
            if (resUrl.includes('douyinpic.com') && (resUrl.includes('tplv-dy-aweme-images') || resUrl.includes('tos-cn-i-'))) {
                capturedImages.add(fixUrlProtocol(resUrl.replace(':q75.webp', ':q100.webp')));
            }
        });

        // Mở trang để gán Cookie & Bypass CORS
        await fetchPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});

        let resultData = null;

        // BƯỚC A: Thử fetch qua API v1 ngầm trong context trình duyệt
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

                    // Xử lý Ảnh
                    let images = [];
                    if (detail.images && detail.images.length > 0) {
                        images = detail.images.map(img => {
                            const raw = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
                            return raw ? raw.replace(':q75.webp', ':q100.webp') : null;
                        }).filter(Boolean);
                    }

                    // Xử lý Video (Chuyển link playwm thành play không logo & gỡ mã hóa HD)
                    const urlList = detail.video?.play_addr?.url_list || detail.video?.bit_rate?.[0]?.play_addr?.url_list || [];
                    let videoUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0] || null;
                    if (videoUrl) {
                        videoUrl = videoUrl.replace('playwm', 'play');
                    }

                    const cover = images.length > 0 
                        ? images[0] 
                        : (detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0] || null);

                    return {
                        id: vId,
                        title: detail.desc || 'Bài đăng Douyin',
                        cover: cover,
                        author: detail.author?.nickname || 'Douyin User',
                        videoUrl: videoUrl,
                        images: images,
                        musicUrl: detail.music?.play_url?.url_list?.[0] || null
                    };
                } catch (e) {
                    return null;
                }
            }, itemId);
        }

        // BƯỚC B: Fallback - Điều hướng thẳng vào bài viết và trích xuất Script Data
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            console.log(`🌐 [DOUYIN] Fallback: Điều hướng trực tiếp URL -> ${targetUrl}`);
            await fetchPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

            const pageData = await fetchPage.evaluate(() => {
                try {
                    // Quét các thẻ Script dữ liệu của Douyin
                    const scripts = Array.from(document.querySelectorAll('script'));
                    for (const script of scripts) {
                        const content = script.innerText || script.textContent || '';
                        
                        // Cấu trúc 1: RENDER_DATA
                        if (content.includes('RENDER_DATA')) {
                            const decodedText = decodeURIComponent(content.replace(/.*?RENDER_DATA\s*=\s*/, '').trim());
                            const jsonData = JSON.parse(decodedText);
                            for (const k in jsonData) {
                                if (jsonData[k]?.awemeDetail) return jsonData[k].awemeDetail;
                                if (jsonData[k]?.noteDetail) return jsonData[k].noteDetail;
                            }
                        }

                        // Cấu trúc 2: _SSR_DATA hoặc __INIT_PROPERTIES__
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
            } else if (capturedImages.size > 0) {
                const imgList = Array.from(capturedImages);
                resultData = {
                    id: itemId || Date.now().toString(),
                    title: 'Tập ảnh Douyin (Note)',
                    cover: imgList[0],
                    author: 'Douyin Creator',
                    videoUrl: null,
                    images: imgList,
                    musicUrl: null
                };
            }
        }

        // Kiểm tra kết quả
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            throw new Error('Không bóc tách được dữ liệu Video hoặc Ảnh từ Douyin!');
        }

        // Chuẩn hóa toàn bộ URL HTTP/HTTPS
        resultData.videoUrl = fixUrlProtocol(resultData.videoUrl);
        resultData.cover = fixUrlProtocol(resultData.cover);
        resultData.musicUrl = fixUrlProtocol(resultData.musicUrl);
        resultData.images = resultData.images.map(fixUrlProtocol);

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'douyin',
            data: resultData
        };

    } finally {
        if (fetchPage) await fetchPage.close().catch(() => {});
    }
}

/**
 * Trích xuất Aweme ID từ chuỗi URL
 */
function extractAwemeId(url) {
    if (!url) return null;
    const match = url.match(/(?:video|note|slideshow|modal_id=)\/??(\d{18,20})/i) || url.match(/(\d{18,20})/);
    return match ? match[1] : null;
}

/**
 * Định dạng dữ liệu từ Object JSON của Douyin
 */
function formatParsedData(detail) {
    const vId = detail.aweme_id || detail.item_id || '';

    let images = [];
    if (detail.images && detail.images.length > 0) {
        images = detail.images.map(img => {
            const raw = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
            return raw ? raw.replace(':q75.webp', ':q100.webp') : null;
        }).filter(Boolean);
    }

    const urlList = detail.video?.play_addr?.url_list || detail.video?.bit_rate?.[0]?.play_addr?.url_list || [];
    let videoUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0] || null;
    if (videoUrl) {
        videoUrl = videoUrl.replace('playwm', 'play');
    }

    const cover = images.length > 0 
        ? images[0] 
        : (detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0] || null);

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

/**
 * Đảm bảo URL luôn có tiền tố https:
 */
function fixUrlProtocol(url) {
    if (!url || typeof url !== 'string') return null;
    if (url.startsWith('//')) return `https:${url}`;
    return url;
}