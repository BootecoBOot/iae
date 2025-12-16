const axios = require('axios');
const cheerio = require('cheerio');
const { GOOGLE_MAPS_API_KEY } = process.env;

class GoogleSearchEnhancer {
  constructor() {
    this.searchCache = new Map();
    this.CACHE_TTL = 1000 * 60 * 60 * 12; // 12 horas de cache
  }

  /**
   * Busca informações adicionais sobre um estabelecimento no Google
   * @param {string} placeName - Nome do estabelecimento
   * @param {string} city - Cidade para refinar a busca
   * @returns {Promise<Object>} Dados complementares encontrados
   */
  async enhanceWithGoogleSearch(placeName, city = '') {
    const cacheKey = `search:${placeName}:${city}`;
    const cached = this.searchCache.get(cacheKey);
    
    if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
      return cached.data;
    }

    try {
      const searchTerm = `${placeName} ${city} site:instagram.com OR site:tripadvisor.com.br OR site:facebook.com`;
      const response = await axios.get('https://www.google.com/search', {
        params: { q: searchTerm },
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        },
      });

      const $ = cheerio.load(response.data);
      const results = [];

      // Extrai os primeiros 5 resultados da busca
      $('div.g').each((i, el) => {
        if (i >= 5) return;
        
        const title = $(el).find('h3').text().trim();
        const url = $(el).find('a').attr('href');
        const snippet = $(el).find('div.VwiC3b').text().trim();
        
        if (title && url) {
          results.push({
            title,
            url: this.cleanUrl(url),
            snippet,
            source: this.detectSource(url)
          });
        }
      });

      // Processa os resultados para extrair informações estruturadas
      const enhancedData = this.processSearchResults(placeName, results);
      
      // Armazena no cache
      this.searchCache.set(cacheKey, {
        data: enhancedData,
        timestamp: Date.now()
      });

      return enhancedData;
    } catch (error) {
      console.error('Erro na busca do Google:', error.message);
      return {};
    }
  }

  /**
   * Processa os resultados da busca para extrair informações úteis
   */
  processSearchResults(placeName, results) {
    const features = {
      socialMedia: {},
      reviews: [],
      hours: null,
      events: [],
      hasLiveMusic: { value: false, confidence: 0, sources: [] },
      isGoodForGroups: { value: false, confidence: 0, sources: [] },
      // Adicione mais features conforme necessário
    };

    const keywords = {
      hasLiveMusic: ['música ao vivo', 'show', 'banda', 'apresentação', 'ao vivo'],
      isGoodForGroups: ['grupo', 'amigos', 'festa', 'aniversário', 'confraternização']
    };

    results.forEach(result => {
      const { title, url, snippet, source } = result;
      const textToAnalyze = `${title} ${snippet}`.toLowerCase();

      // Verifica características baseadas em palavras-chave
      Object.entries(keywords).forEach(([feature, terms]) => {
        if (terms.some(term => textToAnalyze.includes(term))) {
          features[feature].value = true;
          features[feature].confidence = Math.min(1, features[feature].confidence + 0.3);
          features[feature].sources.push({
            url,
            source,
            text: snippet
          });
        }
      });

      // Extrai redes sociais
      if (source === 'instagram' && !features.socialMedia.instagram) {
        features.socialMedia.instagram = url;
      } else if (source === 'facebook' && !features.socialMedia.facebook) {
        features.socialMedia.facebook = url;
      }

      // Extrai avaliações
      if (source === 'tripadvisor') {
        const ratingMatch = snippet.match(/(\d+[.,]?\d*)(?:\s*de\s*\d+[.,]?\d*)?\s*(?:estrelas|estrela)/i);
        if (ratingMatch) {
          features.reviews.push({
            source: 'TripAdvisor',
            rating: parseFloat(ratingMatch[1].replace(',', '.')),
            url
          });
        }
      }
    });

    return features;
  }

  /**
   * Limpa a URL removendo parâmetros desnecessários
   */
  cleanUrl(url) {
    try {
      const urlObj = new URL(url.startsWith('http') ? url : `https://${url}`);
      
      // Mantém apenas o domínio e o caminho para URLs de redes sociais
      if (urlObj.hostname.includes('facebook.com') || 
          urlObj.hostname.includes('instagram.com')) {
        return `${urlObj.protocol}//${urlObj.hostname}${urlObj.pathname}`.replace(/\/+$/, '');
      }
      
      return urlObj.toString();
    } catch (e) {
      return url;
    }
  }

  /**
   * Detecta a fonte do resultado da busca
   */
  detectSource(url) {
    if (!url) return 'unknown';
    
    const urlLower = url.toLowerCase();
    
    if (urlLower.includes('instagram.com')) return 'instagram';
    if (urlLower.includes('facebook.com')) return 'facebook';
    if (urlLower.includes('tripadvisor.')) return 'tripadvisor';
    if (urlLower.includes('google.com/maps') || urlLower.includes('google.com.br/maps')) return 'google_maps';
    
    return 'other';
  }
}

module.exports = new GoogleSearchEnhancer();
