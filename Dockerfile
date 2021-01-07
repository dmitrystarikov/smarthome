FROM node:14.15.4-alpine3.12

RUN npm install mqtt --save

COPY index.js ./

ENTRYPOINT ["node"]
CMD ["index.js"]