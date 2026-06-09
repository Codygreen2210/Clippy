FROM node:20-slim

RUN apt-get update && apt-get install -y \
  ffmpeg \
  python3 \
  python3-pip \
  curl \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp

# Tell yt-dlp to use Node.js for signature solving
ENV YT_DLP_JS_RUNTIME=node

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p /tmp/clips

EXPOSE 3000

CMD ["node", "server.js"]
