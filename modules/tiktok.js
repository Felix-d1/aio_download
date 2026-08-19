import axios from 'axios';

/**
 * Module bóc tách dữ liệu TikTok (Video & Album ảnh)
 * @param {import('puppeteer').Browser} browser - Instance puppeteer dùng chung (dùng dự phòng nếu cần)
 * @param {string} url - Link TikTok cần bóc tách
 */
export async function parseTikTok(browser, url) {
    const startTime = Date.now();

    try {
        // Tối ưu tốc độ: Gọi API TikWM / TikWM endpoint để lấy trực tiếp dữ liệu gốc chất lượng cao không watermark
        const apiUrl = `https://www.tikwm.com/api/?url=${encodeURIComponent(url)}?hd=1`;

        const response = await axios.get(apiUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
            },
            timeout: 10000
        });

        const resData = response.data;

        if (resData.code !== 0 || !resData.data) {
            throw new Error(resData.msg || 'Không thể bóc tách dữ liệu từ liên kết TikTok này.');
        }

        const data = resData.data;
        const processTime = ((Date.now() - startTime) / 1000).toFixed(2) + 's';

        // Kiểm tra xem bài đăng TikTok là Album ảnh (Photo Mode) hay Video
        const isPhotoSlide = data.images && Array.isArray(data.images) && data.images.length > 0;

        return {
            platform: 'tiktok',
            processTime: processTime,
            data: {
                id: data.id || Date.now().toString(),
                title: data.title || 'TikTok Video',
                author: data.author?.unique_id || data.author?.nickname || 'tiktok_user',
                cover: data.cover || data.origin_cover,
                // Luồng Video HD & SD không logo
                videoHD: data.hdplay ? (data.hdplay.startsWith('http') ? data.hdplay : `https://www.tikwm.com${data.hdplay}`) : null,
                videoSD: data.play ? (data.play.startsWith('http') ? data.play : `https://www.tikwm.com${data.play}`) : null,
                videoUrl: data.hdplay || data.play,
                // Nhạc nền MP3
                musicUrl: data.music,
                // Album ảnh (nếu là bài đăng dạng ảnh)
                images: isPhotoSlide ? data.images : []
            }
        };

    } catch (err) {
        console.error('❌ [TIKTOK MODULE ERROR]:', err.message);
        throw new Error('Không thể tải bài viết TikTok. Hãy kiểm tra lại đường dẫn!');
    }
}