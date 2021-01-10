ARG ARCH=
FROM ${ARCH}node:14.15.4-alpine3.12

RUN npm install mqtt yaml --save

WORKDIR /app

COPY index.js ./

EXPOSE 8080/tcp

ENTRYPOINT ["node"]
CMD ["/app/index.js"]