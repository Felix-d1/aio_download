FROM node:20-slim

# Cài đặt Google Chrome và các thư viện cần thiết cho Puppeteer
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | apt-key add - \
    && sh -c 'echo "deb [arch=amd64] http://dl.google.com/linux/chrome/deb/ stable main" >> /etc/apt/sources.list.d/google.list' \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy các tệp cấu hình
COPY package*.json ./

# Cài đặt dependencies (bỏ qua script chuẩn bị nếu có)
RUN npm install --production --ignore-scripts

# Copy toàn bộ nguồn
COPY . .

EXPOSE 3000

CMD ["npm", "start"]