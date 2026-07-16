// The sites to scrape. Kept out of main.js so scripts can import the list
// without executing main.js's run() call.
const MUNICIPALITIES = [
  { publisher: "עיריית חיפה", url: "https://www2.haifa.muni.il/Michrazim/Default.aspx", script: "./scrapers/haifa.js" },
  { publisher: "עיריית הרצליה", url: "https://www.herzliya.muni.il/bids/", script: "./scrapers/herzliya.js" },
  { publisher: "עיריית אשדוד", url: "https://www.ashdod.muni.il/he-il/אתר-העיר/מכרזים/מכרזים-כלליים/", script: "./scrapers/ashdod.js" },
  { publisher: "עיריית מודיעין מכבים רעות", url: "https://www.modiin.muni.il/modiinwebsite/ChannelArticle.aspx?PageID=487_468", script: "./scrapers/modiin.js" },
  { publisher: "עיריית מודיעין עלית", url: "https://www.modil.org.il/bids/?archive=0&category=3", script: "./scrapers/modiin-illit.js" },
  { publisher: "מועצה אזורית חבל מודיעין", url: "https://www.modiin-region.muni.il/bids/", script: "./scrapers/hevel-modiin.js" },
  { publisher: "החברה הכלכלית מודיעין", url: "https://hacal.co.il/%D7%9E%D7%9B%D7%A8%D7%96%D7%99%D7%9D/", script: "./scrapers/hacal-modiin.js" },
  { publisher: "עיריית חולון", url: "https://www.holon.muni.il/CityHall/Bids/Pages/default.aspx", script: "./scrapers/holon.js" },
  { publisher: "עיריית ירושלים", url: "https://www.jerusalem.muni.il/he/city/tenders/contractorstenders/kablanim/", script: "./scrapers/jerusalem.js" },
  { publisher: "עיריית אשקלון", url: "https://ashkelon.muni.gov.il/he/העירייה/מכרזים?status=open", script: "./scrapers/ashkelon.js" },
  { publisher: "עיריית תל אביב", url: "https://www.tel-aviv.gov.il/AuctionAndCareers/Pages/Service.aspx", script: "./scrapers/tel-aviv.js" },
  { publisher: "עיריית ראשון לציון", url: "https://www.rishonlezion.muni.il/Activities/Tenders/Pages/Contracting_tenders.aspx", script: "./scrapers/rishon-lezion.js" },
  { publisher: "עיריית בני ברק", url: "https://www.bnei-brak.muni.il/bids/category/mikhrazim/", script: "./scrapers/bnei-brak.js" },
  { publisher: "עיריית באר שבע", url: "https://www.beer-sheva.muni.il/City/FreeInfo/Rehesh/Pages/Bids.aspx", script: "./scrapers/beer-sheva.js" }
];

module.exports = { MUNICIPALITIES };
