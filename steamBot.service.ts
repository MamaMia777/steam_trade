import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { MicroservicesErrors } from '@warskin/common';
import CEconItem from 'steamcommunity/classes/CEconItem';
import CConfirmation from 'steamcommunity/classes/CConfirmation';
import axios from "axios";
import * as SteamUser from "steam-user";
import * as TradeOfferManager from "steam-tradeoffer-manager";
import * as SteamCommunity from "steamcommunity";
import {getAuthCode} from "steam-totp";
const { getConfirmationKey, time } =  require('steam-totp');
interface IBotCollection {
  // @ts-ignore
  readonly user: SteamUser;
  // @ts-ignore
  readonly manager: TradeOfferManager;
  // @ts-ignore
  readonly community: SteamCommunity;
  readonly sharedSecret: string;
  readonly identitySecret: string;
}
interface SteamLogin {
  readonly id: string;
  readonly guardToken: string;
  readonly oAuthToken: string;
  readonly sharedSecret: string;
  readonly identitySecret: string;
}

export interface SendTradeOffer {
  steamId: string;
  targetSteamId?: string;
  tradeUrl: string;
  appId: number;
  itemsName: Array<string>;
  nonce: string;
}

enum ConfirmationTag {
  GetAll = 'conf',
  GetDetails = 'details',
  Accept = 'allow',
  Cancel = 'cancel',
}

enum ConfirmationType {
  Trade = 2,
  MarketListing = 3,
}

interface ExCConfirmation extends CConfirmation {
  offerID: any;
}

export interface ISteamInventory {
  assets: Asset[];
  descriptions: Description[];
  total_inventory_count: number;
  success: number;
  rwgrsn: number;
}

export interface Asset {
  appid: number;
  contextid: string;
  assetid: string;
  classid: string;
  instanceid: string;
  amount: string;
}

export interface Description {
  appid: number;
  classid: string;
  instanceid: string;
  currency: number;
  background_color: string;
  icon_url: string;
  icon_url_large: string;
  descriptions: Description2[];
  tradable: number;
  actions?: Action[];
  name: string;
  name_color: string;
  type: string;
  market_name: string;
  market_hash_name: string;
  market_actions?: MarketAction[];
  commodity: number;
  market_tradable_restriction: number;
  marketable: number;
  tags: Tag[];
}

export interface Description2 {
  type: string;
  value: string;
  color?: string;
}

export interface Action {
  link: string;
  name: string;
}

export interface MarketAction {
  link: string;
  name: string;
}

export interface Tag {
  category: string;
  internal_name: string;
  localized_category_name: string;
  localized_tag_name: string;
  color?: string;
}
export interface ISteamMarket {
  success: boolean;
  lowest_price: string;
  volume: string;
  median_price: string;
}
export interface IOrdersObject {
  price: number;
  name: string;
  icon_url: string;
}

@Injectable()
export class SteamService {
  private readonly botsCollection: Map<string, IBotCollection> = new Map<
    string,
    IBotCollection
  >();
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor() {}

  public async login(dto: SteamLogin) {
    let isError = false;
    const community = new SteamCommunity();
    let user: any;
    let manager = new TradeOfferManager({ steam: new SteamUser()})
    community.oAuthLogin(dto.guardToken, dto.oAuthToken, (err, sessionID, cookies) => {
      console.log(sessionID, cookies)
      if(err) isError = true;
      community.setCookies(cookies as any)
      community.getClientLogonToken((err, details) => {
        user = new SteamUser({enablePicsCache: true});
        // Ensure that we have logged in properly and that our app information has loaded in
        user.logOn(details);
        user.on("loggedOn", () => {
          console.log("TEST")
          manager.setCookies(cookies as any);
          user.on("appOwnershipCached", () => {});
        });
      })
    })
    manager.on('sentOfferChanged', function (offer, oldState) {
      Logger.log(
          `[STEAM SERVICE] SteamID ${dto.id} Offer #${offer.id} changed: ${
              TradeOfferManager.ETradeOfferState[oldState]
          } -> ${TradeOfferManager.ETradeOfferState[offer.state]}`,
      );
    });

    if (isError) {
      user.logOff();
      Logger.log(
          `[STEAM SERVICE] SteamID ${dto.id} is logoff because have cookies error`,
      );
    } else {
      this.botsCollection.set(dto.id, {
        user,
        manager,
        community,
        sharedSecret: dto.sharedSecret,
        identitySecret: dto.identitySecret,
      });
    }
  }

  public async sendTrade(dto: SendTradeOffer) {
    const bot = this.botsCollection.get(dto.steamId);
    let offerId; // if user send items to bot
    if (dto.targetSteamId) {
      bot.manager.getUserInventoryContents(
        dto.targetSteamId,
        dto.appId,
        2,
        true,
        (err, inventory) => {
          if (err) {
            throw new InternalServerErrorException(
              MicroservicesErrors.USER_INV_ERROR,
            );
          }
          if (inventory.length === 0) {
            throw new BadRequestException(MicroservicesErrors.USER_INV_EMPTY);
          }

          const offer = bot.manager.createOffer(dto.tradeUrl);
          const items: Array<CEconItem> = [];
          dto.itemsName.map((name) => {
            items.push(inventory.filter((el) => el.name === name)[0]);
          });
          offer.addTheirItems(items);
          offer.setMessage(dto.nonce);
          offer.send((err, status) => {
            if (err) {
              //TRADE BAN or new connection(less 7 day)
              throw new InternalServerErrorException(
                MicroservicesErrors.STEAM_CANT_SEND_OFFER,
              );
            }
            console.log(status);
            if (status === 'pending') {
              //confirm
            } else {
              console.log(`Offer ${offer.id} sent`);
              offerId = offer.id;
            }
          });
        },
      );
      return offerId;
    } else {
      // if bot send to user items
      bot.manager.getInventoryContents(dto.appId, 2, true, (err, inventory) => {
        if (err) {
          console.log(err);
          throw new InternalServerErrorException(
            MicroservicesErrors.STEAM_CANT_GET_INVETORY,
          );
        }
        if (inventory.length === 0) {
          throw new InternalServerErrorException(
            MicroservicesErrors.STEAM_BOT_INVETORY_EMPTY,
          );
        }
        const offer = bot.manager.createOffer(dto.tradeUrl);
        const items: Array<CEconItem> = [];
        dto.itemsName.map((name) => {
          items.push(inventory.find((el) => el.name === name));
        });
        offer.addMyItems(items);

        offer.send((err, status) => {
          if (err) {
            //TRADE BAN or new connection(less 7 day)
            throw new InternalServerErrorException(
              MicroservicesErrors.STEAM_BOT_INTERNAL_ERROR,
            );
          }
          if (status === 'pending') {
            //Confirmation logic
            offerId = offer.id;
            const time = Math.floor(Date.now() / 1000)
            const confKey = getConfirmationKey(bot.identitySecret, time, 'conf')
            const allowKey = getConfirmationKey(bot.identitySecret, time, 'allow')

            bot.community.acceptAllConfirmations(time, confKey, allowKey, (err) => {
            })
            // bot.community.getConfirmations(
            //   time(),
            //   getConfirmationKey(
            //     bot.identitySecret,
            //     time(),
            //     ConfirmationTag.GetAll,
            //   ),
            //   async (err, confirmations) => {
            //     const _confirmations: Array<ExCConfirmation> = [];
            //     for (const confirmation of confirmations) {
            //       if(confirmation.offerID === offer.id) {
            //         const time = Math.floor(Date.now() / 1000)
            //         const confKey = getConfirmationKey(bot.identitySecret, time, 'conf')
            //         const allowKey = getConfirmationKey(bot.identitySecret, time, 'allow')
            //         confirmation.respond(time, confKey, allowKey, this.confirmationCb);
            //       }
            //       _confirmations.push(
            //         confirmation.type == ConfirmationType.Trade
            //           ? await this.populateConfirmation(
            //               confirmation,
            //               bot.identitySecret,
            //             )
            //           : confirmation,
            //       );
            //     }
            //   },
            // );
          } else {
            console.log('[STEAM SERVICE] bot succesfyle send trade');
          }
        });
      });
      return offerId;
    }
  }

  /**
   *
   * @param confirmation
   * @param identity_secret
   * @private
   * @return confirmation with offerId
   */
  private async populateConfirmation(
    confirmation: CConfirmation,
    identity_secret: string,
  ) {
    return new Promise<any>((resolve) => {
      confirmation.getOfferID(
        time(),
        getConfirmationKey(identity_secret, time(), ConfirmationTag.GetDetails),
        (err, offerID) => {
          if (err) return resolve(confirmation);
          resolve({ ...confirmation, offerID });
        },
      );
    });
  }

  private async confirmationCb(err: any) {
    if (err) {
      console.log(err);
      throw new InternalServerErrorException(
        MicroservicesErrors.STEAM_BOT_COMMYNITY_CONFIRMATION_ERROR,
      );
    }
  }

  public async getUserInventory(steamId: string, appid) {
    const { data } = await axios.get<ISteamInventory>(
      `http://steamcommunity.com/inventory/${steamId}/${appid}/2?l=english&count=5000`,
    );
    if (!data) return null; //Get only without trade ban & marketable
    const inventory = data.descriptions
      .filter((el) => el.tradable === 1)
      .filter((el) => el.marketable === 1);

    const temp: Array<IOrdersObject> = [];

    inventory.map((inv) =>{

      const url = new URL('http://steamcommunity.com/market/priceoverview/');
      url.searchParams.append('appid', appid);
      url.searchParams.append('market_hash_name', inv.market_hash_name);
      url.searchParams.append('currency', '1');
      axios
        .get<ISteamMarket>(url.toString())
        .then((res) => {
          const price = parseFloat(res.data.lowest_price.split('$')[1]);
          const result = (price / 100) * 10;
          temp.push({
            price: price + result,
            icon_url: inv.icon_url,
            name: inv.name,
          })
        })
        .catch(() => {
          //console.error('ERROR RATE LIMIT MAYBE idk');
        });
    })
    return temp;
  }
}
