FROM oven/bun:latest

# 安装 jsdom 需要的系统依赖
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制 package.json
COPY package.json bun.lock ./

# 安装依赖
RUN bun install

# 复制源代码
COPY . .

# 暴露端口
EXPOSE 8080

# 启动应用
CMD ["bun", "run", "src/index.ts"]
