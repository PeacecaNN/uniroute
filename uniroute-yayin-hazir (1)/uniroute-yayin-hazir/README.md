# UniRoute — Yayına Hazır Paket

Bu paket Vercel + Render için hazırlanmıştır. `node_modules`, `.next` ve gerçek API anahtarı pakete dahil değildir.

## Klasörler

- `client`: Next.js arayüzü — Vercel'e yayınlanır.
- `server`: Express API ve üniversite CSV'si — Render'a yayınlanır.
- `render.yaml`: Render Blueprint ayarı.

## Bilgisayarda test

Node.js 20.9 veya üzeri gerekir.

```powershell
npm.cmd install
npm.cmd --prefix client install
npm.cmd --prefix server install
copy server\.env.example server\.env
npm.cmd run dev
```

`server/.env` dosyasında `GOOGLE_MAPS_API_KEY` değerini değiştir. Site `http://localhost:3000`, API `http://localhost:3001` adresinde açılır.

## İnternete yayınlama

### 1) GitHub

GitHub Desktop ile bu klasörü repository olarak oluştur, commit et ve GitHub'a yayınla. Repository özel kalabilir.

### 2) Render — server

Render'da **New > Blueprint** seçip GitHub repository'sini bağla. `render.yaml` server ayarlarını otomatik doldurur.

İstenen değişkenlere şunları yaz:

- `GOOGLE_MAPS_API_KEY`: Google Cloud anahtarın.
- `FRONTEND_URL`: Vercel adresi belli olduktan sonra `https://...vercel.app` şeklinde girilecek.

Render'ın verdiği API adresini kopyala. Örnek: `https://uniroute-api.onrender.com`

### 3) Vercel — client

Vercel'de repository'yi Import et.

- Root Directory: `client`
- Framework: Next.js
- Environment Variable:
  - Ad: `NEXT_PUBLIC_API_URL`
  - Değer: Render API adresi; sonunda `/api` veya `/` bulunmasın.

Deploy bitince Vercel site adresini kopyala.

### 4) Render CORS

Render'da `FRONTEND_URL` değişkenini Vercel adresin yap ve servisi yeniden deploy et.

## Google Cloud

Aynı projede şunlar açık olmalı:

- Routes API
- Geocoding API
- Places API (New)

API anahtarını yalnızca Render ortam değişkenine gir. `.env` dosyasını GitHub'a yükleme.
