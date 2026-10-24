# Bot de ScrabbleBot + loop de automejora, para Railway.
FROM node:22-slim
WORKDIR /app
COPY spacetimedb/wordlist.txt spacetimedb/wordlist.txt
COPY bot-starter/package.json bot-starter/package-lock.json bot-starter/
RUN cd bot-starter && npm ci
COPY bot-starter/ bot-starter/
# Los bindings del bot están en .gitignore; usamos los de la web (mismo módulo).
COPY src/module_bindings/ bot-starter/src/module_bindings/
WORKDIR /app/bot-starter
CMD ["./railway-start.sh"]
