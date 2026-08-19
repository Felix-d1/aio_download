# Sử dụng Image Puppeteer chính thức đã tích hợp sẵn Google Chrome và Node.js
FROM ghcr.io/puppeteer/puppeteer:21.5.0

# Thiết lập biến môi trường để Puppeteer sử dụng Google Chrome hệ thống
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable \
    NODE_ENV=production

# Chuyển quyền làm việc sang user root để cài đặt và sao chép file
USER root

# Tạo thư mục ứng dụng
WORKDIR /usr/src/app

# Sao chép package.json và package-lock.json (nếu có)
COPY package*.json ./

# Đổi dòng cũ:
# RUN npm ci --only=production

# Thành dòng mới:
RUN npm install --omit=dev

# Sao chép toàn bộ mã nguồn vào Container
COPY . .

# Phân quyền cho Puppeteer user để tránh lỗi bảo mật sandbox
RUN chown -R pptruser:pptruser /usr/src/app

# Chuyển sang user pptruser an toàn của Puppeteer
USER pptruser

# Mở cổng 3000 (Render sẽ tự động ánh xạ PORT này)
EXPOSE 3000

# Lệnh khởi chạy server
CMD ["node", "server.js"]