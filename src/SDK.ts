import { ChannelId, LiveChatVersion, OCSDKTelemetryEvent, SDKError } from "./Common/Enums";
import axios, { AxiosRequestConfig, AxiosResponse } from "axios";
import axiosRetryHandler, { axiosRetryHandlerWithNotFound } from "./Utils/axiosRetryHandler";

import { BrowserInfo } from "./Utils/BrowserInfo";
import Constants from "./Common/Constants";
import { CustomContextData } from "./Utils/CustomContextData";
import { DeviceInfo } from "./Utils/DeviceInfo";
import FetchChatTokenResponse from "./Model/FetchChatTokenResponse";
import Hex from "crypto-js/enc-hex";
import IDataMaskingInfo from "./Interfaces/IDataMaskingInfo";
import IEmailTranscriptOptionalParams from "./Interfaces/IEmailTranscriptOptionalParams";
import IGetChatTokenOptionalParams from "./Interfaces/IGetChatTokenOptionalParams";
import IGetChatTranscriptsOptionalParams from "./Interfaces/IGetChatTranscriptsOptionalParams";
import IGetLWIDetailsOptionalParams from "./Interfaces/IGetLWIDetailsOptionalParams";
import IGetQueueAvailabilityOptionalParams from "./Interfaces/IGetQueueAvailabilityOptionalParams";
import IGetSurveyInviteLinkOptionalParams from "./Interfaces/IGetSurveyInviteLinkOptionalParams";
import IOmnichannelConfiguration from "./Interfaces/IOmnichannelConfiguration";
import IReconnectAvailabilityOptionalParams from "./Interfaces/IReconnectAvailabilityOptionalParams";
import IReconnectableChatsParams from "./Interfaces/IReconnectableChatsParams";
import ISDK from "./Interfaces/ISDK";
import ISDKConfiguration from "./Interfaces/ISDKConfiguration";
import ISecondaryChannelEventOptionalParams from "./Interfaces/ISecondaryChannelEventOptionalParams";
import ISendTypingIndicatorOptionalParams from "./Interfaces/ISendTypingIndicatorOptionalParams"
import ISessionCloseOptionalParams from "./Interfaces/ISessionCloseOptionalParams";
import ISessionInitOptionalParams from "./Interfaces/ISessionInitOptionalParams";
import ISubmitPostChatResponseOptionalParams from "./Interfaces/ISubmitPostChatResponseOptionalParams";
import IValidateAuthChatRecordOptionalParams from "./Interfaces/IValidateAuthChatRecordOptionalParams";
import InitContext from "./Model/InitContext";
import Locales from "./Common/Locales";
import { LogLevel } from "./Model/LogLevel";
import { LoggingSanitizer } from "./Utils/LoggingSanitizer";
import OCSDKLogger from "./Common/OCSDKLogger";
import { OSInfo } from "./Utils/OSInfo";
import OmnichannelEndpoints from "./Common/OmnichannelEndpoints";
import OmnichannelHTTPHeaders from "./Common/OmnichannelHTTPHeaders";
import OmnichannelQueryParameter from "./Interfaces/OmnichannelQueryParameter";
import QueueAvailability from "./Model/QueueAvailability";
import ReconnectAvailability from "./Model/ReconnectAvailability";
import ReconnectMappingRecord from "./Model/ReconnectMappingRecord";
import { RequestTimeoutConfig } from "./Common/RequestTimeoutConfig";
import SHA256 from "crypto-js/sha256";
import { StringMap } from "./Common/Mappings";
import { Timer } from "./Utils/Timer";
import { addOcUserAgentHeader } from "./Utils/httpHeadersUtils";
import { createGetChatTokenEndpoint } from "./Utils/endpointsCreators";
import isExpectedAxiosError from "./Utils/isExpectedAxiosError";
import sessionInitRetryHandler from "./Utils/SessionInitRetryHandler";
import { uuidv4 } from "./Utils/uuid";
import { waitTimeBetweenRetriesConfigs } from "./Utils/waitTimeBetweenRetriesConfigs";

export default class SDK implements ISDK {
  private static defaultRequestTimeoutConfig: RequestTimeoutConfig = {
    getChatConfig: 120000,
    getLWIDetails: 15000,
    getChatToken: 15000,
    sessionInit: 15000,
    sessionClose: 15000,
    getReconnectableChats: 15000,
    getReconnectAvailability: 15000,
    submitPostChatResponse: 15000,
    getSurveyInviteLink: 15000,
    getChatTranscripts: 30000,
    emailTranscript: 5000,
    fetchDataMaskingInfo: 5000,
    makeSecondaryChannelEventRequest: 15000,
    getAgentAvailability: 15000,
    sendTypingIndicator: 5000,
    validateAuthChatRecordTimeout: 15000
  };

  private static defaultConfiguration: ISDKConfiguration = {
    authCodeNonce: uuidv4().substring(0, 8),
    getChatTokenRetryCount: 10,
    getChatTokenTimeBetweenRetriesOnFailure: 10000,
    getChatTokenRetryOn429: true,
    maxRequestRetriesOnFailure: 5,
    defaultRequestTimeout: undefined,
    requestTimeoutConfig: SDK.defaultRequestTimeoutConfig,
    useUnauthReconnectIdSigQueryParam: false,
    waitTimeBetweenRetriesConfig: waitTimeBetweenRetriesConfigs,
    ocUserAgent: []
  };

  liveChatVersion: number;
  sessionId?: string;
  ocUserAgent: string[];
  HTTPTimeOutErrorMessage = `${SDKError.ClientHTTPTimeoutErrorName}: ${SDKError.ClientHTTPTimeoutErrorMessage}`;


  public constructor(private omnichannelConfiguration: IOmnichannelConfiguration, private configuration: ISDKConfiguration = SDK.defaultConfiguration, private logger?: OCSDKLogger) {
    // Sets to default configuration if passed configuration is empty or is not an object
    if (!Object.keys(this.configuration).length || typeof (configuration) !== "object") {
      this.configuration = SDK.defaultConfiguration;
    }

    // Validate SDK config
    for (const key of Object.keys(SDK.defaultConfiguration)) {
      if (!this.configuration.hasOwnProperty(key)) { // eslint-disable-line no-prototype-builtins
        this.configuration[`${key}`] = SDK.defaultConfiguration[`${key}`];
      }
    }

    // Validate individual endpointTimeout config
    for (const key of Object.keys(SDK.defaultConfiguration["requestTimeoutConfig"])) {
      if (!this.configuration["requestTimeoutConfig"].hasOwnProperty(key)) { // eslint-disable-line no-prototype-builtins
        this.configuration["requestTimeoutConfig"][`${key}`] = SDK.defaultConfiguration["requestTimeoutConfig"][`${key}`];
      }
    }

    // Validate channelId
    const { channelId } = omnichannelConfiguration;
    if (!Object.values(ChannelId).includes(channelId as ChannelId)) {
      throw new Error(`Invalid channelId`);
    }

    // Validate OC config
    const currentOmnichannelConfigurationParameters = Object.keys(omnichannelConfiguration);
    for (const key of Constants.requiredOmnichannelConfigurationParameters) {
      if (!currentOmnichannelConfigurationParameters.includes(key)) {
        throw new Error(`Missing '${key}' in OmnichannelConfiguration`);
      }
    }

    this.ocUserAgent = this.configuration.ocUserAgent;
    this.liveChatVersion = LiveChatVersion.V2;
  }

  /**
   * Fetches LCW FCS Details of the Org.
   */
  public async getLcwFcsDetails(): Promise<object | void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETLCWFCSDETAILSSTARTED, "Get LCW FCS details started", "");

    const requestPath = `/${OmnichannelEndpoints.LcwFcsDetailsPath}/${this.omnichannelConfiguration.orgId}`;
    const method = "GET";
    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getChatConfig
    });

    const requestHeaders = {};
    addOcUserAgentHeader(this.ocUserAgent, requestHeaders);

    try {
      const response = await axiosInstance.get(url, {
        headers: requestHeaders,
        timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getChatConfig
      });
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      const { data } = response;
      this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETLCWFCSDETAILSSUCCEEDED, "Get LCW FCS details succeeded", "", response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
      return data;
    } catch (error) {
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETLCWFCSDETAILSFAILED, "Get LCW FCS details failed", "", undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
      throw error;
    }
  }

  /**
   * Fetches chat config.
   * @param requestId: RequestId to use to get chat config (Optional).
   */
  public async getChatConfig(requestId: string, bypassCache = false): Promise<object | void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATCONFIGFSTARTED, "Get Chat config started", requestId);
    if (!requestId) {
      requestId = uuidv4();
    }

    const requestPath = `/${OmnichannelEndpoints.LiveChatConfigPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}?requestId=${requestId}&channelId=${this.omnichannelConfiguration.channelId}`;
    const method = "GET";
    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getChatConfig
    });

    let requestHeaders = {};
    this.addDefaultHeaders(requestId, requestHeaders);

    if (bypassCache) {
      requestHeaders = { ...Constants.bypassCacheHeaders, ...requestHeaders };
    }

    try {
      const response = await axiosInstance.get(url, {
        headers: requestHeaders,
        timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getChatConfig
      });
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      const { data } = response;

      if (data.LiveChatVersion) {
        this.liveChatVersion = data.LiveChatVersion;
      }

      data.headers = {};
      if (response.headers && response.headers["date"]) {
        data.headers["date"] = response.headers["date"];
      }
      this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATCONFIGSUCCEEDED, "Get Chat config succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

      return data;
    } catch (error) {
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATCONFIGFAILED, "Get Chat config failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
      return Promise.reject(error);
    }
  }

  /**
   * Fetches LWI details.
   * @param requestId: RequestId to use to get chat config (Optional).
   * @param getLWIDetailsOptionalParams: Optional parameters for get LWI Details.
   */
  public async getLWIDetails(requestId: string, getLWIDetailsOptionalParams: IGetLWIDetailsOptionalParams = {}): Promise<object> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETLWISTATUSSTARTED, "Get LWI Details Started", requestId);

    if (!requestId) {
      requestId = uuidv4();
    }

    // construct a endpoint for anonymous chats to get LWI Details
    let requestPath = `/${OmnichannelEndpoints.LiveChatLiveWorkItemDetailsPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;
    const axiosInstance = axios.create();
    axiosRetryHandlerWithNotFound(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getLWIDetails,
    });

    // Extract auth token and reconnect id from optional param
    const { authenticatedUserToken, reconnectId } = getLWIDetailsOptionalParams;
    const requestHeaders: StringMap = Constants.defaultHeaders;

    // updated auth endpoint for authenticated chats and add auth token in header
    if (authenticatedUserToken) {
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthLiveWorkItemDetailsPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    // If should only be applicable on unauth chat & the flag enabled
    const shouldUseSigQueryParam = !authenticatedUserToken && this.configuration.useUnauthReconnectIdSigQueryParam === true;
    if (reconnectId) {
      if (!shouldUseSigQueryParam) {
        requestPath += `/${reconnectId}`;
      }
    }

    const params: OmnichannelQueryParameter = {
      channelId: this.omnichannelConfiguration.channelId
    };

    if (reconnectId) {
      if (shouldUseSigQueryParam) {
        params.sig = reconnectId;
      }
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      params,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getLWIDetails
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);

        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETLWISTATUSSUCCEEDED, "Get LWI Details succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve(data);

      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETLWISTATUSFAILED, "Get LWI Details failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }
  /**
   * Fetches the chat token from Omnichannel to join T1 thread.
   * @param requestId: RequestId to use for getchattoken (Optional).
   * @param getChatTokenOptionalParams: Optional parameters for get chat token.
   */
  public async getChatToken(requestId: string, getChatTokenOptionalParams: IGetChatTokenOptionalParams = {}, currentRetryCount: number = 0): Promise<FetchChatTokenResponse> { // eslint-disable-line @typescript-eslint/no-inferrable-types
    const timer = Timer.TIMER();
    const { reconnectId, authenticatedUserToken, currentLiveChatVersion, refreshToken, MsOcBotApplicationId } = getChatTokenOptionalParams;
    const multiBot = (MsOcBotApplicationId && MsOcBotApplicationId.length > 0)? true: false;
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATTOKENSTARTED, "Get Chat Token Started", requestId);

    if (currentRetryCount < 0) {
      throw new Error(`Invalid currentRetryCount`);
    }

    if (!requestId) {
      requestId = uuidv4();
    }

    const requestHeaders: StringMap = Constants.defaultHeaders;
    this.addDefaultHeaders(requestId, requestHeaders);

    const endpoint = createGetChatTokenEndpoint(currentLiveChatVersion as LiveChatVersion || this.liveChatVersion, authenticatedUserToken ? true : false, multiBot);

    if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    let requestPath = `/${endpoint}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;
    
    // If should only be applicable on unauth chat & the flag enabled
    const shouldUseSigQueryParam = !authenticatedUserToken && this.configuration.useUnauthReconnectIdSigQueryParam === true;
    if (reconnectId) {
      if (!shouldUseSigQueryParam) {
        requestPath += `/${reconnectId}`;
      }
    }

    const params: OmnichannelQueryParameter = {
      channelId: this.omnichannelConfiguration.channelId
    }
    if (MsOcBotApplicationId && MsOcBotApplicationId.length > 0) {
      params['Ms-Oc-Bot-Application-Id'] = MsOcBotApplicationId;
    }

    if (refreshToken) {
      params.refreshToken = 'true'
    }

    if (reconnectId) {
      if (shouldUseSigQueryParam) {
        params.sig = reconnectId;
      }
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      params,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getChatToken
    };

    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: (currentRetryCount > this.configuration.maxRequestRetriesOnFailure) ? currentRetryCount : this.configuration.maxRequestRetriesOnFailure,
      retryOn429: this.configuration.getChatTokenRetryOn429,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getChatToken
    });

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);

        if (headers) {
          if (headers[OmnichannelHTTPHeaders.ocSessionId.toLowerCase()]) {
            this.sessionId = headers[OmnichannelHTTPHeaders.ocSessionId.toLowerCase()];
          }
        }

        // Resolves only if it contains chat token response which only happens on status 200
        if (data) {
          
          // check if data is empty, if so, then reject the promise
          if (Object.keys(data).length === 0) {
            reject(new Error("Empty data received from getChatToken"));
            return;
          }

          data.requestId = requestId;
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATTOKENSUCCEEDED, "Get Chat Token succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
          resolve(data);
          return;
        }

        // No content for reconnect chat case shouldn't be retried.
        if (reconnectId && response.status === Constants.noContentStatusCode) {
          reject(response);
          return;
        }

      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETCHATTOKENFAILED, "Get Chat Token failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Fetches the reconnectable chats from omnichannel from the given user information in JWT token(claim name: sub).
   * @param reconnectableChatsParams Mandate parameters for get reconnectable chats.
   */
  public async getReconnectableChats(reconnectableChatsParams: IReconnectableChatsParams): Promise<ReconnectMappingRecord | void> {
    const timer = Timer.TIMER();
    const { authenticatedUserToken } = reconnectableChatsParams;
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETRECONNECTABLECHATSSTARTED, "Get Reconnectable chat Started");
    const requestId = reconnectableChatsParams?.requestId;

    const requestPath = `/${OmnichannelEndpoints.LiveChatGetReconnectableChatsPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
    requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getReconnectableChats
    };

    const axiosInstance = axios.create();

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);

        // Resolves only if it contains reconnectable chats response which only happens on status 200
        if (data) {
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETRECONNECTABLECHATSSUCCEEDED, "Get Reconnectable Chats Succeeded and old session returned", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
          resolve(data);
          return;
        }
        // No data found in the old sessions so returning null
        resolve();
        return;
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETRECONNECTABLECHATSFAILED, "Get Reconnectable Chats failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
        return;
      }
    });
  }

  /**
 * Fetches the reconnectable chats from omnichannel from the given user information in JWT token(claim name: sub).
 * @param reconnectableChatsParams Mandate parameters for get reconnectable chats.
 */
  public async getReconnectAvailability(reconnectId: string, optionalParams: IReconnectAvailabilityOptionalParams = {}): Promise<ReconnectAvailability | void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETRECONNECTAVAILABILITYSTARTED, "Get Reconnectable availability Started");

    const requestPath = `/${OmnichannelEndpoints.LiveChatReconnectAvailabilityPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${reconnectId}`;
    const requestHeaders: StringMap = Constants.defaultHeaders;

    this.addDefaultHeaders(optionalParams?.requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getReconnectAvailability
    };

    const axiosInstance = axios.create();
    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data } = response;
        if (data) {
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETRECONNECTAVAILABILITYSUCCEEDED, "Get Reconnect availability succeeded", optionalParams?.requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

          resolve(data);
          return;
        }
        // No data found so returning null
        this.logWithLogger(LogLevel.WARN, OCSDKTelemetryEvent.GETRECONNECTAVAILABILITYSUCCEEDED, "Get Reconnect availability didn't send any valid data", optionalParams?.requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

        resolve();
        return;
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETRECONNECTAVAILABILITYFAILED, "Get Reconnect Availability failed", optionalParams?.requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
        return;
      }
    });
  }

  /**
   *
   * @param requestId: RequestId to use for session init.
   * @param queueAvailabilityOptionalParams: Optional parameters for session init.
   */
  public async getAgentAvailability(requestId: string, queueAvailabilityOptionalParams: IGetQueueAvailabilityOptionalParams = {}): Promise<QueueAvailability> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETAGENTAVAILABILITYSTARTED, "Get agent availability Started", requestId);

    const requestPath = `/${OmnichannelEndpoints.GetAgentAvailabilityPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=lcw`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getAgentAvailability
    });

    const { authenticatedUserToken, initContext, getContext } = queueAvailabilityOptionalParams;

    const requestHeaders: StringMap = Constants.defaultHeaders;

    if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    const data: InitContext = initContext || {};

    const cachObj = {
      "orgId": this.omnichannelConfiguration.orgId,
      "widgetId": this.omnichannelConfiguration.widgetId
    }

    if (data && data.customContextData) {
      const tempArr = CustomContextData.sort(data.customContextData);
      Object.assign(cachObj, { "customContext": tempArr });
    }

    if (data.portalcontactid) {
      Object.assign(cachObj, { "portalcontactid": data.portalcontactid });
    }

    //data.cacheKey = hash.createHash('sha256').update(JSON.stringify(cachObj)).digest('hex').toString();
    data.cacheKey = SHA256(JSON.stringify(cachObj)).toString(Hex);

    if (getContext && !window.document) {
      return Promise.reject(new Error(`getContext is only supported on web browsers`));
    }

    if (getContext) {
      data.browser = BrowserInfo.getBrowserName();
      data.device = DeviceInfo.getDeviceType();
      data.originurl = window.location.href;
      data.os = OSInfo.getOsType();
    }

    if (!data.locale) {
      data.locale = Constants.defaultLocale;
    }

    // Validate locale
    if (data.locale && !Locales.supportedLocales.includes(data.locale)) {
      return Promise.reject(new Error(`Unsupported locale: '${data.locale}'`));
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";

    const options: AxiosRequestConfig = {
      data,
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getAgentAvailability
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);

        if (data) {
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETAGENTAVAILABILITYSUCCEEDED, "Get agent availability succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

          resolve(data);
        }
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETAGENTAVAILABILITYFAILED, "Get agent availability failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);

        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**'
   * Starts a session to omnichannel.
   * @param requestId: RequestId to use for session init.
   * @param sessionInitOptionalParams: Optional parameters for session init.
   */
  public async sessionInit(requestId: string, sessionInitOptionalParams: ISessionInitOptionalParams = {}): Promise<void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SESSIONINITSTARTED, "Session Init Started", requestId);
    const axiosInstance = axios.create();
    const retryOn429 = true;
    axiosRetryHandler(axiosInstance, {
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.sessionInit,
      shouldRetry: (error) => sessionInitRetryHandler(error, retryOn429),
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce]
    });

    const { reconnectId, authenticatedUserToken, initContext, getContext } = sessionInitOptionalParams;
    const data: InitContext = initContext || {};
    const requestHeaders: StringMap = { ...Constants.defaultHeaders };

    const basePath = authenticatedUserToken
      ? OmnichannelEndpoints.LiveChatAuthSessionInitPath
      : OmnichannelEndpoints.LiveChatSessionInitPath;

    let requestPath = `/${basePath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;

    if (authenticatedUserToken) {     
      Object.assign(requestHeaders, {
        [OmnichannelHTTPHeaders.authenticatedUserToken]: authenticatedUserToken,
        [OmnichannelHTTPHeaders.authCodeNonce]: this.configuration.authCodeNonce,
      });
    }

    this.addDefaultHeaders(requestId, requestHeaders);
    this.setRequestIdHeader(requestId, requestHeaders);


    // If should only be applicable on unauth chat & the flag enabled
    const shouldUseSigQueryParam = !authenticatedUserToken && this.configuration.useUnauthReconnectIdSigQueryParam === true;
    if (reconnectId) {
      if (!shouldUseSigQueryParam) {
        requestPath += `/${reconnectId}`;
      }
    }

    const params: OmnichannelQueryParameter = {
      channelId: this.omnichannelConfiguration.channelId
    }

    if (reconnectId && shouldUseSigQueryParam) {
      params.sig = reconnectId;
    }

    if (getContext && !window.document) {
      return Promise.reject(new Error(`getContext is only supported on web browsers`));
    }

    if (getContext) {
      data.browser = BrowserInfo.getBrowserName();
      data.device = DeviceInfo.getDeviceType();
      data.originurl = window.location.href;
      data.os = OSInfo.getOsType();
    }

    // Set default locale if locale is empty
    if (!data.locale) {
      data.locale = Constants.defaultLocale;
    }

    // Validate locale
    if (data.locale && !Locales.supportedLocales.includes(data.locale)) {
      return Promise.reject(new Error(`Unsupported locale: '${data.locale}'`));
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data,
      headers: requestHeaders,
      method,
      url,
      params,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.sessionInit
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SESSIONINITSUCCEEDED, "Session Init Succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, data, requestHeaders);
        resolve();
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.SESSIONINITFAILED, "Session Init failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, data, requestHeaders);
        
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  public async createConversation(requestId: string, sessionInitOptionalParams: ISessionInitOptionalParams = {}): Promise<FetchChatTokenResponse> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.CREATESESSIONSTARTED, "Create conversation call Started", requestId);
    const axiosInstance = axios.create();
    const retryOn429 = true;
    axiosRetryHandler(axiosInstance, {
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.sessionInit,
      shouldRetry: (error) => sessionInitRetryHandler(error, retryOn429),
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce]
    });

    const { reconnectId, authenticatedUserToken, initContext, getContext } = sessionInitOptionalParams;
    const data: InitContext = initContext || {};
    const requestHeaders: StringMap = { ...Constants.defaultHeaders };

    const basePath = authenticatedUserToken
      ? OmnichannelEndpoints.LiveChatConnectorAuthPath
      : OmnichannelEndpoints.LiveChatConnectorPath;

    const requestPath = `/${basePath}/${this.omnichannelConfiguration.orgId}/widgetApp/${this.omnichannelConfiguration.widgetId}/conversation`;

    if (authenticatedUserToken) {     
      Object.assign(requestHeaders, {
        [OmnichannelHTTPHeaders.authenticatedUserToken]: authenticatedUserToken,
        [OmnichannelHTTPHeaders.authCodeNonce]: this.configuration.authCodeNonce,
      });
    }

    this.addDefaultHeaders(requestId, requestHeaders);
    this.setRequestIdHeader(requestId, requestHeaders);

    if (reconnectId) {
      data.reconnectId = reconnectId;
    }

    data.channelId = this.omnichannelConfiguration.channelId;

    if (getContext && !window.document) {
      return Promise.reject(new Error(`getContext is only supported on web browsers`));
    }

    if (getContext) {
      data.browser = BrowserInfo.getBrowserName();
      data.device = DeviceInfo.getDeviceType();
      data.originurl = window.location.href;
      data.os = OSInfo.getOsType();
    }

    // Set default locale if locale is empty
    if (!data.locale) {
      data.locale = Constants.defaultLocale;
    }

    // Validate locale
    if (data.locale && !Locales.supportedLocales.includes(data.locale)) {
      return Promise.reject(new Error(`Unsupported locale: '${data.locale}'`));
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data,
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.sessionInit
    };

    try {
      const response = await axiosInstance(options);
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      const { data, headers } = response;
      this.setAuthCodeNonce(headers);

      if (headers) {
        if (headers[OmnichannelHTTPHeaders.ocSessionId.toLowerCase()]) {
          this.sessionId = headers[OmnichannelHTTPHeaders.ocSessionId.toLowerCase()];
        }
      }
      
      // check if data is empty, if so, then throw an error
      if (Object.keys(data).length === 0) {
        throw new Error("Empty data received from getChatToken");
      }

      data.requestId = requestId;
      this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.CREATESESSIONSUCCEEDED, "Create coversation call Succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
      return data;
    } catch (error) {
      const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
      this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.CREATESESSIONFAILED, "Create conversation call failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, data, requestHeaders);
      
      if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
        throw new Error(this.HTTPTimeOutErrorMessage);
      }
      throw error;
    }
  }

  /**
   * Closes the omnichannel session.
   * @param requestId: RequestId to use for session close (same request id for session init).
   * @param sessionCloseOptionalParams: Optional parameters for session close.
   */
  public async sessionClose(requestId: string, sessionCloseOptionalParams: ISessionCloseOptionalParams = {}): Promise<void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SESSIONCLOSESTARTED, "Session Close Started", requestId);

    let requestPath = `/${OmnichannelEndpoints.LiveChatSessionClosePath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.sessionClose
    });

    const { authenticatedUserToken, isReconnectChat, isPersistentChat, chatId } = sessionCloseOptionalParams;

    const requestHeaders: StringMap = Constants.defaultHeaders;
    const data: any = {}; // eslint-disable-line @typescript-eslint/no-explicit-any
    data.chatId = chatId;

    if (authenticatedUserToken) {
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthSessionClosePath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    if (isReconnectChat) {
      requestPath += `&isReconnectChat=true`;
    }

    if (isPersistentChat) {
      requestPath += `&isPersistentChat=true`;
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data,
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.sessionClose
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SESSIONCLOSESUCCEEDED, "Session Close succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

        resolve();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.SESSIONCLOSEFAILED, "Session close failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (error.code === Constants.axiosTimeoutErrorCode) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Validate the auth chat record exists in database.
   * @param requestId: RequestId for validateAuthChatRecord (same request id for session init).
   * @param validateAuthChatRecordOptionalParams: Optional parameters for validateAuthChatRecord.
   */
  public async validateAuthChatRecord(requestId: string, validateAuthChatRecordOptionalParams: IValidateAuthChatRecordOptionalParams): Promise<object> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.VALIDATEAUTHCHATRECORDSTARTED, "Validate Auth Chat Record Started", requestId);

    const { authenticatedUserToken, chatId } = validateAuthChatRecordOptionalParams;
    const requestPath = `/${OmnichannelEndpoints.LiveChatValidateAuthChatMapRecordPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${chatId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.validateAuthChatRecord
    });

    const requestHeaders: StringMap = Constants.defaultHeaders;
    if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.validateAuthChatRecordTimeout
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        if (response.data?.authChatExist === true) {
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.VALIDATEAUTHCHATRECORDSUCCEEDED, "Validate Auth Chat Record succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

          resolve(response.data);
        } else {
          this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.VALIDATEAUTHCHATRECORDFAILED, "Validate Auth Chat Record Failed. Record is not found or request is not authorized", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

          reject(new Error("Validate Auth Chat Record Failed. Record is not found or request is not authorized"));
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;

        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.VALIDATEAUTHCHATRECORDFAILED, "Validate Auth Chat Record failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);

        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }

        if (error.toString() === "Error: Request failed with status code 404") { // backward compatibility
          resolve({});
        } else {
          reject(error);
        }
      }
    });
  }

  /**
   * Submits post chat response.
   * @param requestId RequestId of the omnichannel session.
   * @param postChatResponse Post chat response to submit.
   * @param submitPostChatResponseOptionalParams: Optional parameters for submit post chat response.
   */
  public async submitPostChatResponse(requestId: string, postChatResponse: object, submitPostChatResponseOptionalParams: ISubmitPostChatResponseOptionalParams = {}): Promise<void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SUBMITPOSTCHATSTARTED, "Submit Post Chat Started", requestId);

    let requestPath = `/${OmnichannelEndpoints.LiveChatSubmitPostChatPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.submitPostChatResponse
    });

    const { authenticatedUserToken } = submitPostChatResponseOptionalParams;
    const requestHeaders: StringMap = Constants.defaultHeaders;
    this.addDefaultHeaders(requestId, requestHeaders);

    if (authenticatedUserToken) {
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthSubmitPostChatPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data: JSON.stringify(postChatResponse),
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.submitPostChatResponse
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SUBMITPOSTCHATSUCCEEDED, "Submit Post Chat succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);

        resolve();

      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.SUBMITPOSTCHATFAILED, "Submit Post Chat Failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Submits post chat response.
   * @param requestId RequestId of the omnichannel session.
   * @param postChatResponse Post chat response to submit.
   * @param submitPostChatResponseOptionalParams: Optional parameters for submit post chat response.
   */
  public async getSurveyInviteLink(surveyOwnerId: string, surveyInviteAPIRequestBody: object, getsurveyInviteLinkOptionalParams: IGetSurveyInviteLinkOptionalParams = {}): Promise<object> {
    const timer = Timer.TIMER();
    if (this.logger) {
      this.logger.log(LogLevel.INFO,
        OCSDKTelemetryEvent.GETSURVEYINVITELINKSTARTED,
        { SurveyOwnerId: surveyOwnerId },
        "Get Survey Invite Link Started");
    }
    let requestPath = `/${OmnichannelEndpoints.LiveChatGetSurveyInviteLinkPath}/${this.omnichannelConfiguration.orgId}/${surveyOwnerId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getSurveyInviteLink
    });

    const { authenticatedUserToken, requestId } = getsurveyInviteLinkOptionalParams;

    const requestHeaders: StringMap = Constants.defaultHeaders;

    if (authenticatedUserToken) {
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthGetSurveyInviteLinkPath}/${this.omnichannelConfiguration.orgId}/${surveyOwnerId}`;
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
      requestHeaders[OmnichannelHTTPHeaders.widgetAppId] = this.omnichannelConfiguration.widgetId;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    if (requestId) {
      requestHeaders[OmnichannelHTTPHeaders.requestId] = requestId;
    }

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data: JSON.stringify(surveyInviteAPIRequestBody),
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getSurveyInviteLink
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETSURVEYINVITELINKSUCCEEDED, "Get Survey Invite Link Succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve(data);
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETSURVEYINVITELINKFAILED, "Get Survey Invite Link failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Get chat transcripts for customer.
   * @param requestId RequestId of the omnichannel session.
   * @param chatId Chat thread Id.
   * @param token Skype token.
   * @param getChatTranscriptsOptionalParams Optional parameters for get chat transcripts.
   */
  public async getChatTranscripts(requestId: string, chatId: string, token: string, getChatTranscriptsOptionalParams: IGetChatTranscriptsOptionalParams = {}): Promise<string> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATTRANSCRIPTSTARTED, "Get Chat Transcript Started", requestId);

    let requestPath = `/${OmnichannelEndpoints.LiveChatGetChatTranscriptPath}/${chatId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.getChatTranscripts
    });

    const { authenticatedUserToken, currentLiveChatVersion } = getChatTranscriptsOptionalParams;
    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.organizationId] = this.omnichannelConfiguration.orgId;
    requestHeaders[OmnichannelHTTPHeaders.widgetAppId] = this.omnichannelConfiguration.widgetId;
    requestHeaders[OmnichannelHTTPHeaders.authorization] = token;

    if (this.liveChatVersion === LiveChatVersion.V2 || (currentLiveChatVersion && currentLiveChatVersion === LiveChatVersion.V2)) {
      requestPath = `/${OmnichannelEndpoints.LiveChatv2GetChatTranscriptPath}/${chatId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
      if (authenticatedUserToken) {
        requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
        requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
        requestPath = `/${OmnichannelEndpoints.LiveChatv2AuthGetChatTranscriptPath}/${chatId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
      }
    }
    else if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthGetChatTranscriptPath}/${chatId}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.getChatTranscripts
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data, headers } = response;
        this.setAuthCodeNonce(headers);
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.GETCHATTRANSCRIPTSUCCEEDED, "Get Chat Transcript succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve(data);
      } catch (error) {
        
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.GETCHATTRANSCRIPTFAILED, "Get Chat Transcript failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject(new Error(this.HTTPTimeOutErrorMessage));

        }
        reject(error);
      }
    });
  }

  /**
   * Email transcript to customer.
   * @param requestId RequestId of the omnichannel session.
   * @param token Skype token.
   * @param emailRequestBody Email request body.
   * @param emailTranscriptOptionalParams Optional parameters for email transcript.
   */
  public async emailTranscript(requestId: string, token: string, emailRequestBody: object, emailTranscriptOptionalParams: IEmailTranscriptOptionalParams = {}): Promise<void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.EMAILTRANSCRIPTSTARTED, "Email Transcript Started", requestId);

    let requestPath = `/${OmnichannelEndpoints.LiveChatTranscriptEmailRequestPath}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.emailTranscript
    });

    const { authenticatedUserToken } = emailTranscriptOptionalParams;
    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.organizationId] = this.omnichannelConfiguration.orgId;
    requestHeaders[OmnichannelHTTPHeaders.widgetAppId] = this.omnichannelConfiguration.widgetId;
    requestHeaders[OmnichannelHTTPHeaders.authorization] = token;

    if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthTranscriptEmailRequestPath}/${requestId}?channelId=${this.omnichannelConfiguration.channelId}`;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data: JSON.stringify(emailRequestBody),
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.emailTranscript
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.EMAILTRANSCRIPTSUCCEEDED, "Email Transcript succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve();
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.EMAILTRANSCRIPTFAILED, "Email Transcript Failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Fetch data masking info of the org.
   * @param requestId RequestId of the omnichannel session (Optional).
   */
  public async fetchDataMaskingInfo(requestId: string): Promise<IDataMaskingInfo> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.FETCHDATAMASKINGSTARTED, "Fetch Data Masking Started", requestId);
    if (!requestId) {
      requestId = uuidv4();
    }

    const requestPath = `/${OmnichannelEndpoints.LiveChatFetchDataMaskingInfoPath}/${this.omnichannelConfiguration.orgId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.fetchDataMaskingInfo
    });

    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.organizationId] = this.omnichannelConfiguration.orgId;
    requestHeaders[OmnichannelHTTPHeaders.requestId] = requestId;

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "GET";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.fetchDataMaskingInfo
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        const { data } = response;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.FETCHDATAMASKINGSUCCEEDED, "Fetch Data Masking succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve(data);
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.FETCHDATAMASKINGFAILED, "Fetch Data Masking Failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Makes a secondary channel event network call to Omnichannel.
   * @param requestId RequestId to use for secondary channel event
   * @param secondaryChannelEventRequestBody secondaryChannel event request body
   * @param secondaryChannelEventOptionalParams Optional parameters for secondary channel events.
   */
  public async makeSecondaryChannelEventRequest(requestId: string, secondaryChannelEventRequestBody: object, secondaryChannelEventOptionalParams: ISecondaryChannelEventOptionalParams = {}): Promise<void> {
    const timer = Timer.TIMER();
    this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SECONDARYCHANNELEVENTREQUESTSTARTED, "Secondary Channel Event Request Started", requestId);

    let requestPath = `/${OmnichannelEndpoints.LiveChatSecondaryChannelEventPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;
    const axiosInstance = axios.create();
    axiosRetryHandler(axiosInstance, {
      headerOverwrites: [OmnichannelHTTPHeaders.authCodeNonce],
      retries: this.configuration.maxRequestRetriesOnFailure,
      waitTimeInMsBetweenRetries: this.configuration.waitTimeBetweenRetriesConfig.makeSecondaryChannelEventRequest
    });

    const { authenticatedUserToken } = secondaryChannelEventOptionalParams;
    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.organizationId] = this.omnichannelConfiguration.orgId;

    if (authenticatedUserToken) {
      requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken] = authenticatedUserToken;
      requestHeaders[OmnichannelHTTPHeaders.authCodeNonce] = this.configuration.authCodeNonce;
      requestPath = `/${OmnichannelEndpoints.LiveChatAuthSecondaryChannelEventPath}/${this.omnichannelConfiguration.orgId}/${this.omnichannelConfiguration.widgetId}/${requestId}`;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    requestPath += "?channelId=" + Constants.defaultChannelId;

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      data: JSON.stringify(secondaryChannelEventRequestBody),
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.makeSecondaryChannelEventRequest
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const { headers } = response;
        this.setAuthCodeNonce(headers);

        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SECONDARYCHANNELEVENTREQUESTSUCCEEDED, "Secondary Channel Event Request Succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve();
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.SECONDARYCHANNELEVENTREQUESTFAILED, "Secondary Channel Event Request Failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);
        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /** Send typing indicator
   * @param requestId RequestId of the omnichannel session.
   */
  public async sendTypingIndicator(requestId: string, currentLiveChatVersion: number, sendTypingIndicatorOptionalParams: ISendTypingIndicatorOptionalParams = {}): Promise<void> {
    // avoiding logging Info for typingindicator to reduce log traffic
    if (!currentLiveChatVersion || currentLiveChatVersion !== LiveChatVersion.V2) {
      return Promise.resolve();
    }
    const timer = Timer.TIMER();
    const { customerDisplayName } = sendTypingIndicatorOptionalParams;
    if (!currentLiveChatVersion || currentLiveChatVersion !== LiveChatVersion.V2) { throw new Error('Typing indicator is only supported on v2') }
    const requestPath = `/${OmnichannelEndpoints.SendTypingIndicatorPath}/${requestId}`;
    const axiosInstance = axios.create();

    const requestHeaders: StringMap = Constants.defaultHeaders;
    requestHeaders[OmnichannelHTTPHeaders.organizationId] = this.omnichannelConfiguration.orgId;
    if (customerDisplayName) {
      requestHeaders[Constants.customerDisplayName] = customerDisplayName;
    }

    this.addDefaultHeaders(requestId, requestHeaders);

    const url = `${this.omnichannelConfiguration.orgUrl}${requestPath}`;
    const method = "POST";
    const options: AxiosRequestConfig = {
      headers: requestHeaders,
      method,
      url,
      timeout: this.configuration.defaultRequestTimeout ?? this.configuration.requestTimeoutConfig.sendTypingIndicator
    };

    return new Promise(async (resolve, reject) => {
      try {
        const response = await axiosInstance(options);
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.INFO, OCSDKTelemetryEvent.SENDTYPINGINDICATORSUCCEEDED, "Send Typing Indicator Succeeded", requestId, response, elapsedTimeInMilliseconds, requestPath, method, undefined, undefined, requestHeaders);
        resolve();
      } catch (error) {
        const elapsedTimeInMilliseconds = timer.milliSecondsElapsed;
        this.logWithLogger(LogLevel.ERROR, OCSDKTelemetryEvent.SENDTYPINGINDICATORFAILED, "Send Typing Indicator Failed", requestId, undefined, elapsedTimeInMilliseconds, requestPath, method, error, undefined, requestHeaders);

        if (isExpectedAxiosError(error, Constants.axiosTimeoutErrorCode)) {
          reject( new Error(this.HTTPTimeOutErrorMessage));
        }
        reject(error);
      }
    });
  }

  /**
   * Helper function for logging.
   *
   * @param logLevel Log level for logging.
   * @param telemetryEventType Telemetry event type in which event will be logged.
   * @param description Description of the event.
   * @param requestId Request ID
   * @param response Response
   * @param elapsedTimeInMilliseconds Elapsed time in ms
   * @param requestPath Request path
   * @param method Method
   * @param error Error
   * @param data Data
   */
  private logWithLogger(logLevel: LogLevel, telemetryEventType: OCSDKTelemetryEvent, description: string, requestId?: string, response?: AxiosResponse<any>, elapsedTimeInMilliseconds?: number, requestPath?: string, method?: string, error?: unknown, requestPayload?: any, requestHeaders?: any): void { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.logger) {
      return;
    }
    if (error) {
      LoggingSanitizer.stripErrorSensitiveProperties(error);
    }

    let sanitizedRequestPayload = undefined;
    if (requestPayload) {
      sanitizedRequestPayload = { ...requestPayload };
      if (sanitizedRequestPayload.customContextData) {
        LoggingSanitizer.stripCustomContextDataValues(sanitizedRequestPayload.customContextData);
      }
      if (sanitizedRequestPayload.preChatResponse) {
        LoggingSanitizer.stripPreChatResponse(sanitizedRequestPayload.preChatResponse);
      }
      LoggingSanitizer.stripGeolocation(sanitizedRequestPayload);
    }

    let sanitizedRequestHeaders = undefined;
    let authTokenDetails: any = undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (requestHeaders) {
      sanitizedRequestHeaders = { ...requestHeaders };
      LoggingSanitizer.stripRequestHeadersSensitiveProperties(sanitizedRequestHeaders);

      if (requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken]) {
        if (window.document && window.atob) {
          try {
            const token = requestHeaders[OmnichannelHTTPHeaders.authenticatedUserToken];
            const payload = token.split(".")[1];
            const data = window.atob(payload);
            const jsonData = JSON.parse(data);
            const lwiContexts = jsonData["lwicontexts"];
            authTokenDetails = {
              sub: jsonData["sub"],
              exp: jsonData["exp"]
            };

            if (lwiContexts) {
              const lwiContextsData = JSON.parse(lwiContexts);
              LoggingSanitizer.stripCustomContextDataValues(lwiContextsData);
              authTokenDetails.lwiContexts = lwiContextsData;
            }
          } catch {
            // eslint-disable-line no-empty
          }
        }
      }
    }

    const customData = {
      RequestId: requestId,
      Region: response?.data.Region,
      ElapsedTimeInMilliseconds: elapsedTimeInMilliseconds,
      TransactionId: response?.headers[Constants.transactionid],
      RequestPath: requestPath,
      RequestMethod: method,
      ResponseStatusCode: response ? response.status : error ? (error as any).response?.status : undefined, // eslint-disable-line @typescript-eslint/no-explicit-any
      ExceptionDetails: error ? (error as any).response?.data || error : undefined, 
      RequestPayload: sanitizedRequestPayload,
      RequestHeaders: sanitizedRequestHeaders,
      ResponseErrorcode: error ? (error as any).response?.headers?.errorcode : undefined, // eslint-disable-line @typescript-eslint/no-explicit-any
      AuthTokenDetails: authTokenDetails
    };
    this.logger.log(logLevel, telemetryEventType, customData, description);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setAuthCodeNonce = (headers: any) => {
    if (headers?.authcodenonce) {
      this.configuration.authCodeNonce = headers?.authcodenonce;
    }
  }

  private addDefaultHeaders(requestId: string | undefined, requestHeaders: StringMap): void {
    this.setSessionIdHeader(this.sessionId, requestHeaders);
    addOcUserAgentHeader(this.ocUserAgent, requestHeaders);
    this.setCorrelationIdInHeader(requestId, requestHeaders);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private setSessionIdHeader = (sessionId: string | undefined, headers: any) => {
    if (sessionId) {
      headers[OmnichannelHTTPHeaders.ocSessionId] = sessionId;
    }
  }

  private setRequestIdHeader = (requestId: string | undefined, headers: StringMap) => {
    if (requestId) {
      headers[OmnichannelHTTPHeaders.requestId] = requestId;
    }
  }

  private setCorrelationIdInHeader = (correlationId: string | undefined, headers: StringMap) => {
    if (correlationId) {
      headers[OmnichannelHTTPHeaders.correlationId] = correlationId;
    }
  }
}
