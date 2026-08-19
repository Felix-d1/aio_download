import axios from 'axios';

// Hàm bóc link Douyin nhận vào Browser instance & shareUrl
export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let fetchPage = null;

    // Lấy URL Douyin từ chuỗi văn bản người dùng dán vào
    const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
    if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

    let targetUrl = urlMatch[0];
    let itemId = extractAwemeId(targetUrl);

    // 1. Giải mã URL nếu dán link ngắn (v.douyin.com)
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
        } catch (e) {
            console.log('⚠️ Không thể giải mã URL bằng Axios, sẽ thử qua Puppeteer...');
        }
    }

    // 2. Nếu có Item ID (chủ động gọi API ngầm qua fetch tab)
    try {
        fetchPage = await browser.newPage();
        await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        // Bắt thêm Network Sniffer dự phòng trường hợp CDN trả về thẳng trên Network
        const capturedImages = new Set();
        fetchPage.on('response', response => {
            const resUrl = response.url();
            if (resUrl.includes('douyinpic.com') && (resUrl.includes('tplv-dy-aweme-images') || resUrl.includes('tos-cn-i-'))) {
                capturedImages.add(resUrl.replace(':q75.webp', ':q100.webp'));
            }
        });

        // Mở trang cách ly robots.txt để bypass CORS khi fetch
        await fetchPage.goto('https://www.douyin.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 6000 }).catch(() => {});

        let resultData = null;

        if (itemId) {
            resultData = await fetchPage.evaluate(async (vId) => {
                try {
                    const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
                    const r = await fetch(apiUrl, { method: 'GET', credentials: 'include' });
                    const data = await r.json();
                    const detail = data?.aweme_detail;
                    if (!detail) return null;

                    // Xử lý danh sách ảnh nếu là bài đăng Tập Ảnh (Note/Slideshow)
                    let images = [];
                    if (detail.images && detail.images.length > 0) {
                        images = detail.images.map(img => {
                            const rawUrl = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
                            return rawUrl ? rawUrl.replace(':q75.webp', ':q100.webp') : null;
                        }).filter(Boolean);
                    }

                    // Xử lý Video
                    const urlList = detail.video?.play_addr?.url_list || [];
                    const cdnUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0];
                    const videoUrl = cdnUrl ? cdnUrl.replace('playwm', 'play') : null;

                    // Cover
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

        // 3. Fallback: Nếu không lấy được qua API v1, tiến hành truy cập trực tiếp bài viết
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            console.log(`🌐 Đang điều hướng trực tiếp đến URL: ${targetUrl}`);
            await fetchPage.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 20000 });

            // Bóc RENDER_DATA từ DOM
            const pageData = await fetchPage.evaluate(() => {
                try {
                    const renderDataScript = document.querySelector('#RENDER_DATA') || document.querySelector('#_ROUTER_DATA');
                    if (renderDataScript) {
                        const decodedText = decodeURIComponent(renderDataScript.innerText || renderDataScript.textContent);
                        const jsonData = JSON.parse(decodedText);
                        for (const key in jsonData) {
                            const item = jsonData[key];
                            if (item?.awemeDetail) return item.awemeDetail;
                            if (item?.noteDetail) return item.noteDetail;
                        }
                    }
                } catch (e) {}
                return null;
            });

            if (pageData) {
                resultData = formatParsedData(pageData);
            } else if (capturedImages.size > 0) {
                // Nếu bắt được ảnh qua Network Tab
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

        // Kiểm tra kết quả cuối cùng
        if (!resultData || (!resultData.videoUrl && resultData.images.length === 0)) {
            throw new Error('Không bóc tách được luồng Video CDN hoặc Tập ảnh từ bài đăng này!');
        }

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'douyin',
            data: resultData
        };

    } finally {
        if (fetchPage) await fetchPage.close().catch(() => {});
    }
}

// Hàm bổ trợ 1: Trích xuất ID từ chuỗi URL (Hỗ trợ cả /video/, /note/, /slideshow/, modal_id)
function extractAwemeId(url) {
    if (!url) return null;
    const match = url.match(/(?:video|note|slideshow|modal_id=)\/??(\d{18,20})/i) || url.match(/(\d{18,20})/);
    return match ? match[1] : null;
}

// Hàm bổ trợ 2: Format dữ liệu chuẩn hóa từ RENDER_DATA
function formatParsedData(detail) {
    const vId = detail.aweme_id || detail.item_id;

    let images = [];
    if (detail.images && detail.images.length > 0) {
        images = detail.images.map(img => {
            const rawUrl = img.url_list?.[img.url_list.length - 1] || img.url_list?.[0];
            return rawUrl ? rawUrl.replace(':q75.webp', ':q100.webp') : null;
        }).filter(Boolean);
    }

    const urlList = detail.video?.play_addr?.url_list || [];
    const cdnUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0];
    const videoUrl = cdnUrl ? cdnUrl.replace('playwm', 'play') : null;

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