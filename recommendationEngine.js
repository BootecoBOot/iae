const axios = require('axios');
const { db } = require('./db');
const { GOOGLE_MAPS_API_KEY } = process.env;
const googleSearchEnhancer = require('./googleSearchEnhancer');

class RecommendationEngine {
  constructor() {
    this.reviewCache = new Map();
    this.enhancedDataCache = new Map();
    this.CACHE_TTL = 1000 * 60 * 60 * 24; // 24 hours
  }

  /**
   * Extract features from Google Business reviews and enhance with web search
   * @param {string} placeId - Google Place ID
   * @param {string} userIntent - User's search intent (e.g., 'música ao vivo', 'ambiente romântico')
   * @param {Object} placeData - Additional place data (name, vicinity, etc.)
   * @returns {Promise<Object>} Inferred features with confidence scores
   */
  async analyzeGoogleReviews(placeId, userIntent, placeData = {}) {
    try {
      // Check cache first
      const cacheKey = `reviews:${placeId}:${userIntent}`;
      const cached = this.reviewCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
        return cached.data;
      }

      // Get place details including reviews from Google Places API
      const response = await axios.get(
        `https://maps.googleapis.com/maps/api/place/details/json`,
        {
          params: {
            place_id: placeId,
            fields: 'reviews,name,vicinity,formatted_address',
            key: GOOGLE_MAPS_API_KEY,
            language: 'pt-BR',
            reviews_sort: 'most_relevant',
            reviews_no_translations: true,
            max_reviews: 5 // Get most relevant 5 reviews
          }
        }
      );

      // Enhance with web search if we have place name and location
      let enhancedData = {};
      if (placeData.name || (response.data.result && response.data.result.name)) {
        const placeName = placeData.name || response.data.result.name;
        const city = placeData.vicinity || (response.data.result.formatted_address || '').split(',').slice(-2).join(',').trim();
        
        try {
          enhancedData = await googleSearchEnhancer.enhanceWithGoogleSearch(placeName, city);
        } catch (error) {
          console.error('Error enhancing with web search:', error.message);
        }
      }

      if (!response.data.result) {
        return enhancedData; // Return any enhanced data even if no reviews
      }
      
      if (!response.data.result.reviews) {
        return enhancedData; // Return any enhanced data even if no reviews
      }

      // Analyze reviews for features and merge with enhanced data
      const reviews = response.data.result.reviews;
      const reviewFeatures = this._extractFeaturesFromReviews(reviews, userIntent);
      
      // Merge features from reviews with enhanced data from web search
      const features = { ...enhancedData };
      
      // Combine features from both sources, giving priority to review data
      Object.keys(reviewFeatures).forEach(key => {
        if (!features[key] || 
            (reviewFeatures[key].confidence > (features[key]?.confidence || 0))) {
          features[key] = {
            ...reviewFeatures[key],
            source: 'google_reviews',
            // Keep the higher confidence score
            confidence: Math.max(
              reviewFeatures[key].confidence, 
              features[key]?.confidence || 0
            )
          };
        }
      });
        
      // Cache the results
      this.reviewCache.set(cacheKey, {
        data: features,
        timestamp: Date.now()
      });

      return features;
    } catch (error) {
      console.error('Error analyzing Google reviews:', error.message);
      return {};
    }
  }


  /**
   * Save user feedback about a place
   * @param {Object} feedback - Feedback data
   * @returns {Promise<boolean>} Success status
   */
  async saveUserFeedback(feedback) {
    try {
      const { userId, placeId, feature, isAccurate, timestamp = Date.now() } = feedback;
      
      await db.run(
        `INSERT INTO place_feedback 
        (user_id, place_id, feature, is_accurate, created_at) 
        VALUES (?, ?, ?, ?, ?)`,
        [userId, placeId, feature, isAccurate ? 1 : 0, timestamp]
      );
      
      return true;
    } catch (error) {
      console.error('Error saving user feedback:', error.message);
      return false;
    }
  }

  /**
   * Get feature confidence based on user feedback
   * @param {string} placeId - Google Place ID
   * @param {string} feature - Feature name
   * @returns {Promise<number>} Confidence score (0-1)
   */
  async getFeatureConfidence(placeId, feature) {
    try {
      const result = await db.get(
        `SELECT 
          COUNT(*) as total,
          SUM(CASE WHEN is_accurate = 1 THEN 1 ELSE 0 END) as accurate
        FROM place_feedback 
        WHERE place_id = ? AND feature = ?`,
        [placeId, feature]
      );

      if (!result || result.total === 0) return 0.5; // Default confidence
      
      return result.accurate / result.total;
    } catch (error) {
      console.error('Error getting feature confidence:', error.message);
      return 0.5; // Default confidence on error
    }
  }

  /**
   * Extract features from review text
   * @private
   */
  _extractFeaturesFromReviews(reviews, userIntent) {
    const features = {
      hasLiveMusic: { value: false, confidence: 0, source: 'google_reviews' },
      isRomantic: { value: false, confidence: 0, source: 'google_reviews' },
      isFamilyFriendly: { value: false, confidence: 0, source: 'google_reviews' },
      isGoodForDates: { value: false, confidence: 0, source: 'google_reviews' },
      isLively: { value: false, confidence: 0, source: 'google_reviews' },
      isGoodForWork: { value: false, confidence: 0, source: 'google_reviews' },
    };

    // Keywords for each feature
    const featureKeywords = {
      hasLiveMusic: ['música ao vivo', 'banda', 'show', 'ao vivo', 'voz e violão', 'palco', 'apresentação'],
      isRomantic: ['romântico', 'romântica', 'aconchegante', 'intimista', 'a luz de velas', 'jantar a dois'],
      isFamilyFriendly: ['familiar', 'crianças', 'kids', 'infantil', 'espaço kids', 'para a família'],
      isGoodForDates: ['encontro', 'date', 'namorado', 'namorada', 'casal', 'jantar romântico'],
      isLively: ['animado', 'festa', 'balada', 'agito', 'movimentado', 'cheio'],
      isGoodForWork: ['trabalhar', 'reunião', 'notebook', 'wi-fi', 'conexão', 'escritório', 'coworking'],
    };

    // Count matches for each feature
    const featureCounts = Object.keys(featureKeywords).reduce((acc, key) => {
      acc[key] = 0;
      return acc;
    }, {});

    // Analyze each review
    reviews.forEach(review => {
      const text = (review.text || '').toLowerCase();
      
      // Check for each feature
      Object.entries(featureKeywords).forEach(([feature, keywords]) => {
        if (keywords.some(keyword => text.includes(keyword))) {
          featureCounts[feature]++;
        }
      });
    });

    // Calculate confidence scores
    Object.keys(featureCounts).forEach(feature => {
      const count = featureCounts[feature];
      if (count > 0) {
        // Simple confidence calculation based on number of mentions
        const confidence = Math.min(1, count / 3); // Cap at 1.0 (3+ mentions)
        features[feature] = {
          value: true,
          confidence: Math.round(confidence * 100) / 100, // Round to 2 decimal places
          source: 'google_reviews'
        };
      }
    });

    return features;
  }

  /**
   * Generate a human-readable response about a feature
   * @param {string} placeName - Name of the place
   * @param {string} feature - Feature name
   * @param {Object} featureData - Feature data with value and confidence
   * @returns {string} Human-readable response
   */
  getFeatureResponse(placeName, feature, featureData) {
    const { value, confidence, source } = featureData;
    
    if (!value || confidence < 0.3) {
      return ''; // Don't mention features with low confidence
    }

    const featurePhrases = {
      hasLiveMusic: {
        high: `O ${placeName} costuma ter música ao vivo, segundo avaliações recentes.`,
        medium: `Algumas pessoas mencionaram que o ${placeName} tem música ao vivo.`,
        low: `Há indicações de que o ${placeName} pode ter música ao vivo.`
      },
      isRomantic: {
        high: `O ${placeName} é conhecido pelo ambiente romântico.`,
        medium: `Algumas avaliações mencionam que o ${placeName} tem um clima romântico.`,
        low: `O ${placeName} pode ser uma boa opção para um encontro romântico.`
      },
      // Add more feature phrases as needed
    };

    const confidenceLevel = confidence > 0.7 ? 'high' : confidence > 0.5 ? 'medium' : 'low';
    const sourceNote = source === 'instagram' ? ' (conforme redes sociais)' : '';
    
    if (featurePhrases[feature] && featurePhrases[feature][confidenceLevel]) {
      return featurePhrases[feature][confidenceLevel] + sourceNote;
    }
    
    return ''; // No phrase defined for this feature
  }
}

module.exports = new RecommendationEngine();
