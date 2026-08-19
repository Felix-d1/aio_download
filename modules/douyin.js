import axios from 'axios';

// Hàm bóc link Douyin nhận vào Browser instance & shareUrl
export async function parseDouyin(browser, shareUrl) {
    const startTime = Date.now();
    let fetchPage = null;

    const urlMatch = shareUrl.match(/https?:\/\/[a-zA-Z0-9\-]+\.douyin\.com\/[^\s"]+/);
    if (!urlMatch) throw new Error('Không tìm thấy URL Douyin hợp lệ!');

    // 1. Giải mã URL lấy Video ID
    const redirectRes = await axios.get(urlMatch[0], {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
        maxRedirects: 5,
        timeout: 5000
    });

    const finalUrl = redirectRes.request.res.responseUrl || redirectRes.config.url;
    const itemId = (finalUrl.match(/video\/(\d+)/) || finalUrl.match(/modal_id=(\d+)/))?.[1];

    if (!itemId) throw new Error('Không bóc tách được Video ID!');

    // 2. Mở isolated tab qua robots.txt để bóc luồng CDN
    fetchPage = await browser.newPage();
    await fetchPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await fetchPage.goto('https://www.douyin.com/robots.txt', { waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});

    const resultData = await fetchPage.evaluate(async (vId) => {
        try {
            const apiUrl = `https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${vId}&device_platform=webapp&aid=6383`;
            const r = await fetch(apiUrl, { method: 'GET', credentials: 'include' });
            const data = await r.json();
            const detail = data?.aweme_detail;
            if (!detail) return null;

            const urlList = detail.video?.play_addr?.url_list || [];
            const cdnUrl = urlList.find(u => u.includes('zjcdn.com')) || urlList[0];

            return {
                id: vId,
                title: detail.desc || 'Video Douyin',
                cover: detail.video?.cover?.url_list?.[0] || detail.video?.origin_cover?.url_list?.[0],
                author: detail.author?.nickname || 'Khách',
                videoUrl: cdnUrl ? cdnUrl.replace('playwm', 'play') : null,
                musicUrl: detail.music?.play_url?.url_list?.[0] || null
            };
        } catch (e) {
            return null;
        }
    }, itemId);

    await fetchPage.close();

    if (!resultData || !resultData.videoUrl) {
        throw new Error('Không bóc được luồng Video CDN từ trang!');
    }

    return {
        processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
        platform: 'douyin',
        data: resultData
    };
}