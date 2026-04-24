// Gunakan Native FormData (Node.js 18+) - JANGAN import package 'form-data'

const FONNTE_API_URL = 'https://api.fonnte.com/send';
const FONNTE_VALIDATE_URL = 'https://api.fonnte.com/validate';

/**
 * Fonnte Service
 * Handles all WhatsApp messaging operations via Fonnte API
 */
class FonnteService {
  /**
   * Test Fonnte API connection with token
   * @param {string} token - Fonnte API token
   * @param {string} testTarget - Phone number to send test message to
   * @param {string} testMessage - Custom message for testing
   * @returns {Promise<object>} Connection status and account info
   */
  async testConnection(token, testTarget, testMessage = 'Test connection from Billing System') {
    try {
      console.log('Testing Fonnte connection...');
      console.log('Target:', testTarget);
      console.log('Message:', testMessage);

      // Gunakan Native FormData (Node.js 18+)
      // JANGAN set header Content-Type manual, native fetch akan otomatis set boundary
      const formData = new FormData();
      formData.append('target', testTarget);
      formData.append('message', testMessage);
      formData.append('countryCode', '62');

      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        headers: {
          Authorization: token,
          // Native fetch otomatis menambahkan Content-Type: multipart/form-data; boundary=...
        },
        body: formData,
      });

      // Baca response sebagai text dulu untuk handle error non-JSON
      const text = await response.text();
      console.log('Fonnte response status:', response.status);
      console.log('Fonnte response text:', text);

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.error('Fonnte response is not valid JSON. Raw response:', text);
        return {
          success: false,
          message: 'Fonnte API Error',
          error: text,
        };
      }

      // Logic response handling
      if (response.status === 200) {
        return {
          success: true,
          message: `Connection successful! Test message sent to ${testTarget}`,
          data: data.data || data.result || { status: 'active' },
        };
      } else if (response.status === 400) {
        return {
          success: true, // Token valid, tapi parameter salah (misal nomor tidak terdaftar)
          message:
            'Token is valid but request failed: ' +
            (data.message || data.reason || 'Check parameters'),
          data: data.data || data.result || { status: 'active' },
        };
      } else if (response.status === 401 || response.status === 403) {
        return {
          success: false,
          message: data.message || 'Invalid token or unauthorized',
          error: data.reason || data.message || 'Token is invalid',
        };
      }

      return {
        success: false,
        message: data.message || 'Connection failed',
        error: data.reason || data.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte test connection error:', error);
      return {
        success: false,
        message: 'Failed to connect to Fonnte API',
        error: error.message,
      };
    }
  }

  /**
   * Validate if a phone number is registered on WhatsApp
   * @param {string} token - Fonnte API token
   * @param {string} target - Phone number to validate
   * @param {string} [countryCode='62'] - Country code
   * @returns {Promise<object>} Validation result with registered/not_registered status
   */
  async validateNumber(token, target, countryCode = '62') {
    try {
      // Normalize phone number
      let normalizedTarget = target.replace(/[^0-9]/g, '');

      // Remove leading zero and add country code if needed
      if (normalizedTarget.startsWith('0')) {
        normalizedTarget = countryCode + normalizedTarget.substring(1);
      } else if (!normalizedTarget.startsWith(countryCode)) {
        normalizedTarget = countryCode + normalizedTarget;
      }

      const response = await fetch(FONNTE_VALIDATE_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target: normalizedTarget,
          countryCode: countryCode,
        }),
      });

      const data = await response.json();

      if (response.ok && data.status) {
        const isRegistered = data.registered && data.registered.length > 0;

        return {
          success: true,
          isRegistered,
          target: normalizedTarget,
          registered: data.registered || [],
          notRegistered: data.not_registered || [],
          message: isRegistered
            ? `Nomor ${normalizedTarget} terdaftar di WhatsApp`
            : `Nomor ${normalizedTarget} TIDAK terdaftar di WhatsApp`,
        };
      }

      return {
        success: false,
        message: data.reason || 'Failed to validate number',
        error: data.reason || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte validate number error:', error);
      return {
        success: false,
        message: 'Failed to validate phone number',
        error: error.message,
      };
    }
  }

  /**
   * Send text message via WhatsApp
   * @param {object} data - Message data
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} [data.countryCode='62'] - Country code
   * @param {number} [data.delay=2] - Delay in seconds
   * @returns {Promise<object>} Send result
   */
  async sendTextMessage(data) {
    const { token, target, message, countryCode = '62', delay = 2 } = data;

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message,
          countryCode,
          delay: delay.toString(),
          schedule: '0',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'Message sent successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to send message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte send text error:', error);
      return {
        success: false,
        message: 'Failed to send message',
        error: error.message,
      };
    }
  }

  /**
   * Send message with attachment (image/PDF)
   * @param {object} data - Message data with attachment
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} data.url - Attachment URL
   * @param {string} data.filename - Filename for attachment
   * @param {string} [data.countryCode='62'] - Country code
   * @param {number} [data.delay=2] - Delay in seconds
   * @returns {Promise<object>} Send result
   */
  async sendWithAttachment(data) {
    const { token, target, message, url, filename, countryCode = '62', delay = 2 } = data;

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message,
          url,
          filename,
          countryCode,
          delay: delay.toString(),
          schedule: '0',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'Message with attachment sent successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to send message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte send attachment error:', error);
      return {
        success: false,
        message: 'Failed to send message with attachment',
        error: error.message,
      };
    }
  }

  /**
   * Send message with schedule
   * @param {object} data - Scheduled message data
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} data.schedule - Schedule timestamp (Unix timestamp or 0 for now)
   * @param {string} [data.countryCode='62'] - Country code
   * @returns {Promise<object>} Send result
   */
  async sendWithSchedule(data) {
    const { token, target, message, schedule, countryCode = '62' } = data;

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message,
          countryCode,
          schedule,
          delay: '2',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'Message scheduled successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to schedule message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte schedule error:', error);
      return {
        success: false,
        message: 'Failed to schedule message',
        error: error.message,
      };
    }
  }

  /**
   * Send message with interactive buttons
   * @param {object} data - Button message data
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} data.footer - Footer text
   * @param {Array} data.buttons - Array of button objects
   * @param {string} [data.countryCode='62'] - Country code
   * @returns {Promise<object>} Send result
   */
  async sendWithButton(data) {
    const { token, target, message, footer, buttons, countryCode = '62' } = data;

    const buttonJSON = JSON.stringify({
      message,
      footer,
      buttons,
    });

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message: 'Interactive message',
          countryCode,
          buttonJSON,
          delay: '2',
          schedule: '0',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'Button message sent successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to send button message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte button error:', error);
      return {
        success: false,
        message: 'Failed to send button message',
        error: error.message,
      };
    }
  }

  /**
   * Send template message
   * @param {object} data - Template message data
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} data.footer - Footer text
   * @param {Array} data.buttons - Array of template button objects
   * @param {string} [data.countryCode='62'] - Country code
   * @returns {Promise<object>} Send result
   */
  async sendWithTemplate(data) {
    const { token, target, message, footer, buttons, countryCode = '62' } = data;

    const templateJSON = JSON.stringify({
      message,
      footer,
      buttons,
    });

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message: 'Template message',
          countryCode,
          templateJSON,
          delay: '2',
          schedule: '0',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'Template message sent successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to send template message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte template error:', error);
      return {
        success: false,
        message: 'Failed to send template message',
        error: error.message,
      };
    }
  }

  /**
   * Send list message
   * @param {object} data - List message data
   * @param {string} data.token - Fonnte API token
   * @param {string} data.target - WhatsApp number
   * @param {string} data.message - Message content
   * @param {string} data.footer - Footer text
   * @param {string} data.buttonTitle - Button title
   * @param {string} data.title - List title
   * @param {Array} data.listData - Array of list sections
   * @param {string} [data.countryCode='62'] - Country code
   * @returns {Promise<object>} Send result
   */
  async sendWithList(data) {
    const {
      token,
      target,
      message,
      footer,
      buttonTitle,
      title,
      listData,
      countryCode = '62',
    } = data;

    const listJSON = JSON.stringify({
      message,
      footer,
      buttonTitle,
      title,
      buttons: listData,
    });

    try {
      const response = await fetch(FONNTE_API_URL, {
        method: 'POST',
        mode: 'cors',
        headers: {
          Authorization: token,
        },
        body: this.createFormData({
          target,
          message: 'List message',
          countryCode,
          listJSON,
          delay: '2',
          schedule: '0',
        }),
      });

      const result = await response.json();

      if (response.ok && result.status) {
        return {
          success: true,
          message: 'List message sent successfully',
          data: result.data,
        };
      }

      return {
        success: false,
        message: result.message || 'Failed to send list message',
        error: result.error || 'Unknown error',
      };
    } catch (error) {
      console.error('Fonnte list error:', error);
      return {
        success: false,
        message: 'Failed to send list message',
        error: error.message,
      };
    }
  }

  /**
   * Create FormData object from data
   * @param {object} data - Data to convert to FormData
   * @returns {FormData} FormData object
   */
  createFormData(data) {
    const formData = new FormData();
    Object.keys(data).forEach((key) => {
      formData.append(key, data[key]);
    });
    return formData;
  }
}

// Export singleton instance
export default new FonnteService();
