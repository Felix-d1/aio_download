/**
 * Module Bóc Tách YouTube Tối Ưu (Fix lỗi mảng Format rỗng)
 */

import ytDlp from 'yt-dlp-exec';
import axios from 'axios';

function extractYouTubeId(url) {
    if (!url || typeof url !== 'string') return null;
    const strUrl = url.trim();
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|shorts\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = strUrl.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

export async function parseYouTube(shareUrl) {
    const startTime = Date.now();

    let targetUrl = shareUrl;
    if (typeof targetUrl === 'object' && targetUrl !== null) {
        targetUrl = targetUrl.url || targetUrl.link || '';
    }

    console.log(`[YouTube Step 1] Trích xuất ID từ: ${targetUrl}`);
    const videoId = extractYouTubeId(targetUrl);
    if (!videoId) {
        console.error('❌ [YouTube Error]: URL không đúng định dạng');
        throw new Error('URL YouTube không hợp lệ!');
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    console.log(`[YouTube Step 2] Đã lấy Video ID: ${videoId}`);

    // --- CÁCH 1: Thử dùng yt-dlp ---
    try {
        console.log(`[YouTube Step 3] Đang gọi yt-dlp...`);

        const ytDlpPromise = ytDlp(cleanUrl, {
            dumpSingleJson: true,
            noWarnings: true,
            noCallHome: true,
            noCheckCertificates: true,
            preferFreeFormats: true,
            youtubeSkipDashManifest: true
        });

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('yt-dlp bị quá thời gian chờ (Timeout 15s)')), 15000)
        );

        const output = await Promise.race([ytDlpPromise, timeoutPromise]);

        console.log(`[YouTube Step 4] yt-dlp phản hồi thành công! Đang xử lý dữ liệu formats...`);

        const allFormats = output.formats || [];

        // 1. Tìm các luồng có cả tiếng và hình (vcodec != none và acodec != none)
        let combinedFormats = allFormats
            .filter(f => f.url && f.vcodec !== 'none' && f.acodec !== 'none')
            .map(f => ({
                quality: f.format_note || (f.height ? `${f.height}p` : '720p'),
                ext: f.ext || 'mp4',
                url: f.url
            }));

        // 2. Nếu không tìm thấy bằng vcodec/acodec, lấy tất cả format có URL
        if (combinedFormats.length === 0) {
            console.log(`⚠️ [YouTube Info] Không tìm thấy luồng lọc vcodec/acodec, lấy danh sách URL khả dụng...`);
            combinedFormats = allFormats
                .filter(f => f.url)
                .map(f => ({
                    quality: f.format_note || (f.height ? `${f.height}p` : 'HD'),
                    ext: f.ext || 'mp4',
                    url: f.url
                }));
        }

        // Lấy link direct tốt nhất
        const bestDirectUrl = combinedFormats[0]?.url || output.url;

        console.log(`[YouTube Step 5] Link direct tìm thấy: ${bestDirectUrl ? 'CÓ (Thành công)' : 'KHÔNG'}`);

        if (bestDirectUrl) {
            return {
                processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
                platform: 'youtube',
                data: {
                    id: videoId,
                    title: output.title || output.fulltitle || 'YouTube Video',
                    cover: output.thumbnail || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    author: output.uploader || output.channel || 'YouTube Channel',
                    durationSeconds: parseInt(output.duration || '0'),
                    viewCount: parseInt(output.view_count || '0'),
                    directPlayUrl: bestDirectUrl,
                    streams: { combined: combinedFormats }
                }
            };
        } else {
            throw new Error('yt-dlp không trả về thuộc tính direct URL hợp lệ');
        }

    } catch (ytDlpError) {
        console.error(`⚠️ [YouTube yt-dlp Thất Bại]: ${ytDlpError.message}`);
        console.log(`🔄 [YouTube Fallback] Đang chuyển sang API Dự Phòng...`);
    }

    // --- CÁCH 2: API Dự Phòng Cobalt ---
    try {
        const response = await axios.post('https://api.cobalt.tools/api/json', {
            url: cleanUrl,
            vQuality: '720'
        }, {
            headers: {
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            timeout: 10000
        });

        if (response.data && response.data.url) {
            console.log(`✅ [YouTube Fallback Thành Công] Lấy link qua API Cobalt thành công!`);
            return {
                processTime: `${((Date.now() - startTime) / 1000).toFixed(2)}s`,
                platform: 'youtube',
                data: {
                    id: videoId,
                    title: 'YouTube Video',
                    cover: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
                    author: 'YouTube',
                    durationSeconds: 0,
                    viewCount: 0,
                    directPlayUrl: response.data.url,
                    streams: {
                        combined: [{ quality: '720p', ext: 'mp4', url: response.data.url }]
                    }
                }
            };
        }
    } catch (fallbackErr) {
        console.error(`❌ [YouTube API Fallback Thất Bại]: ${fallbackErr.message}`);
    }

    throw new Error('Tất cả phương thức bóc tách YouTube đều thất bại.');
}