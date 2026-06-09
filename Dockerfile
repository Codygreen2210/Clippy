FROM node:20-slim

# Install ffmpeg only (cobalt handles downloading, ffmpeg handles cutting)
RUN apt-get update && apt-get install -y \
  ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .

RUN mkdir -p /tmp/clips

EXPOSE 3000

CMD ["node", "server.js"]
