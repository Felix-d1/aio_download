import axios from 'axios';

export async function parseFacebook(browser, shareUrl) {
    const startTime = Date.now();
    let page = null;

    // Lọc lấy URL Facebook hợp lệ
    const urlMatch = shareUrl.match(/https?:\/\/(www\.|m\.|web\.)?(facebook\.com|fb\.watch|fb\.gg)\/[^\s"]+/);
    if (!urlMatch) throw new Error('Không tìm thấy liên kết Facebook hợp lệ!');

    let targetUrl = urlMatch[0];

    try {
        page = await browser.newPage();
        
        // Giả lập User-Agent máy tính tiêu chuẩn
        await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        // Lắng nghe Network Sniffer để bắt link media trực tiếp từ Facebook CDN
        let videoHdUrl = null;
        let videoSdUrl = null;
        const capturedImages = new Set();

        page.on('response', response => {
            const resUrl = response.url();

            // Bắt link CDN video (.mp4)
            if (resUrl.includes('video.fhan') || resUrl.includes('.mp4')) {
                if (resUrl.includes('bytestart') || resUrl.includes('fbcdn.net')) {
                    if (!videoHdUrl) videoHdUrl = resUrl;
                }
            }

            // Bắt link CDN ảnh chất lượng cao
            if (resUrl.includes('scontent') && (resUrl.includes('.jpg') || resUrl.includes('.png') || resUrl.includes('.webp'))) {
                // Lọc bỏ các icon, avatar nhỏ
                if (!resUrl.includes('p50x50') && !resUrl.includes('p100x100') && !resUrl.includes('cp0')) {
                    capturedImages.add(resUrl);
                }
            }
        });

        console.log(`🌐 Puppeteer đang mở link Facebook: ${targetUrl}`);
        await page.goto(targetUrl, { waitUntil: 'networkidle2', timeout: 25000 });

        // Trích xuất dữ liệu trực tiếp từ HTML/JS DOM của Facebook (Relay Prefetch / GraphQL)
        const parsedData = await page.evaluate(() => {
            try {
                const html = document.documentElement.innerHTML;

                // 1. Tìm Link Video HD & SD từ Meta tags hoặc JSON script
                const hdMatch = html.match(/"browser_native_hd_url":"([^"]+)"/) || html.match(/"playable_url_quality_hd":"([^"]+)"/);
                const sdMatch = html.match(/"browser_native_sd_url":"([^"]+)"/) || html.match(/"playable_url":"([^"]+)"/);

                const videoHd = hdMatch ? hdMatch[1].replace(/\\/g, '') : null;
                const videoSd = sdMatch ? sdMatch[1].replace(/\\/g, '') : null;

                // 2. Tìm Tiêu đề bài viết
                const titleMatch = document.querySelector('meta[property="og:title"]')?.content || 
                                 document.querySelector('meta[name="description"]')?.content || 
                                 'Bài đăng Facebook';

                // 3. Tìm Ảnh Bìa (Cover)
                const coverMatch = document.querySelector('meta[property="og:image"]')?.content || null;

                // 4. Quét các URL ảnh HD trong bài đăng
                const images = [];
                const imgRegex = /https:\/\/scontent[^\s"'\\]+/g;
                let m;
                while ((m = imgRegex.exec(html)) !== null) {
                    const cleanImg = m[0].replace(/\\/g, '');
                    if (!images.includes(cleanImg) && !cleanImg.includes('p50x50') && !cleanImg.includes('p100x100')) {
                        images.push(cleanImg);
                    }
                }

                return {
                    title: titleMatch,
                    cover: coverMatch,
                    videoHd: videoHd,
                    videoSd: videoSd,
                    images: images.slice(0, 10) // Lấy tối đa 10 ảnh nét nhất
                };
            } catch (e) {
                return null;
            }
        });

        // Tổng hợp dữ liệu
        let finalVideoUrl = parsedData?.videoHd || parsedData?.videoSd || videoHdUrl;
        let finalImages = (parsedData?.images && parsedData.images.length > 0) ? parsedData.images : Array.from(capturedImages);

        if (!finalVideoUrl && finalImages.length === 0) {
            throw new Error('Không bóc tách được Video hoặc Ảnh từ bài đăng Facebook này! (Bài viết có thể ở chế độ Riêng tư)');
        }

        return {
            processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
            platform: 'facebook',
            data: {
                id: Date.now().toString(),
                title: parsedData?.title || 'Bài viết Facebook',
                author: 'Facebook User',
                cover: parsedData?.cover || (finalImages.length > 0 ? finalImages[0] : null),
                videoUrl: finalVideoUrl,
                images: finalVideoUrl ? [] : finalImages, // Nếu là Video thì ưu tiên trả về Video
                musicUrl: null
            }
        };

    } finally {
        if (page) await page.close().catch(() => {});
    }
}