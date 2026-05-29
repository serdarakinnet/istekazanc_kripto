# 🚀 İsteKazanç Kripto — Binance Otomatik Al-Sat Uygulaması

![Lisans](https://img.shields.io/badge/lisans-MIT-blue.svg)
![Platform](https://img.shields.io/badge/platform-Vercel-black)
![Dil](https://img.shields.io/badge/dil-TypeScript%20%7C%20JavaScript-yellow)
![Veritabanı](https://img.shields.io/badge/veritabanı-Supabase-green)

> Binance API entegrasyonu ile çalışan, otomatik kripto para al-sat işlemleri gerçekleştiren, kar/zarar takibi yapan modern bir ticaret uygulaması.

---

## 📌 İçindekiler

- [Özellikler](#-özellikler)
- [Teknoloji Yığını](#-teknoloji-yığını)
- [Kurulum](#-kurulum)
- [Ortam Değişkenleri](#-ortam-değişkenleri)
- [Kullanım](#-kullanım)
- [Ekran Görüntüleri](#-ekran-görüntüleri)
- [Katkıda Bulunma](#-katkıda-bulunma)
- [Lisans](#-lisans)

---

## ✨ Özellikler

- 📈 **Otomatik Al-Sat** — Binance API üzerinden otomatik emir oluşturma (YAKINDA...)
- 📊 **Son 24 Saat Analizi** — Gerçek zamanlı performans takibi
- 💰 **Kar/Zarar Çizelgesi** — Detaylı işlem geçmişi ve kazanç raporu
- 🗄️ **Supabase Entegrasyonu** — Bulut tabanlı veritabanı ile güvenli veri saklama
- ☁️ **Vercel Dağıtımı** — Hızlı ve kesintisiz sunucu tarafı çalışma
- 🔐 **API Güvenliği** — Binance API anahtarları şifreli ortam değişkenleri ile korunur

---

## 🛠 Teknoloji Yığını

| Katman | Teknoloji |
|---|---|
| Dil | TypeScript / JavaScript |
| Çerçeve | Next.js / Node.js |
| Veritabanı | Supabase (PostgreSQL) |
| Borsa API | Binance API v3 |
| Dağıtım | Vercel |
| Lisans | MIT |

---

## ⚙️ Kurulum

### Gereksinimler

- Node.js >= 18.x
- npm veya yarn
- Binance hesabı ve API anahtarları
- Supabase hesabı

### Adımlar

```bash
# 1. Depoyu klonlayın
git clone https://github.com/serdarakinnet/istekazanc_kripto.git
cd istekazanc_kripto

# 2. Bağımlılıkları yükleyin
npm install

# 3. Ortam değişkenlerini ayarlayın
cp .env.example .env.local

# 4. Geliştirme sunucusunu başlatın
npm run dev
```

---

## 🔑 Ortam Değişkenleri

`.env.local` dosyanıza aşağıdaki değişkenleri ekleyin:

```env
# Binance API
BINANCE_API_KEY=your_binance_api_key
BINANCE_API_SECRET=your_binance_api_secret

# Supabase
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
```

> ⚠️ **Uyarı:** API anahtarlarınızı asla herkese açık bir depoya yüklemeyin!

---

## 🚀 Kullanım

### Geliştirme Ortamı

```bash
npm run dev
```

### Üretim Build

```bash
npm run build
npm start
```

### Vercel'e Dağıtım

```bash
vercel deploy
```

---

## 📂 Proje Yapısı

```
istekazanc_kripto/
├── app/                  # Next.js uygulama dizini
│   ├── api/              # API rotaları (al-sat, rapor vb.)
│   └── page.tsx          # Ana sayfa
├── components/           # UI bileşenleri
├── lib/                  # Yardımcı fonksiyonlar
│   ├── binance.ts        # Binance API entegrasyonu
│   └── supabase.ts       # Supabase istemcisi
├── public/               # Statik dosyalar
├── .env.local            # Ortam değişkenleri (git'e eklenmez)
├── package.json
└── README.md
```

---

## 🤝 Katkıda Bulunma

1. Bu depoyu **fork**'layın
2. Yeni bir dal oluşturun: `git checkout -b ozellik/yeni-ozellik`
3. Değişikliklerinizi kaydedin: `git commit -m 'Yeni özellik eklendi'`
4. Dalınızı gönderin: `git push origin ozellik/yeni-ozellik`
5. **Pull Request** açın

---

## ⚠️ Sorumluluk Reddi

Bu uygulama yalnızca eğitim ve kişisel kullanım amaçlıdır. Kripto para ticareti yüksek risk içerir. Oluşabilecek maddi kayıplardan geliştirici sorumlu tutulamaz.

---

## 📄 Lisans

Bu proje [MIT Lisansı](LICENSE) ile lisanslanmıştır.

---

<p align="center">
  <b>⭐ Projeyi beğendiyseniz yıldız vermeyi unutmayın!</b>
</p>
istekazanc.com
