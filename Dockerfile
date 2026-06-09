FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  python3 \
  python3-pip \
  curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p /tmp/clips

EXPOSE 3000

CMD ["node", "server.js"]
