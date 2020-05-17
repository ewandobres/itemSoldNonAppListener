import * as functions from 'firebase-functions';
import * as admin from 'firebase-admin';

admin.initializeApp();

const db = admin.firestore();
const fcm = admin.messaging();

export const sendToDevice = functions.firestore
    .document('Shops/{shopId}/ItemsOnSale/{itemId}')
    .onUpdate(async snapshot => {
        const itemId = snapshot.after.id;
        const item = snapshot.after.data();
        const shopId = snapshot.after.ref.parent.parent?.id;
        if (item && itemId && shopId) {

            let awaitingPickup: Array<string> = item.awaitingPickup;
            let itemQuantity = item.itemQuantity;
            let itemsReserved = item.itemsReserved;
            let deficit = itemsReserved - itemQuantity;

            if (deficit <= 0) {       //if there are items left, cancels function execution
                console.log("deficit " + deficit)
                return null;
            }

            await db.collection("Shops").doc(shopId).collection("ItemsOnSale").doc(itemId)
                .update({'itemsReserved': itemQuantity,})

            console.log("no deficit " + deficit)
            async function pushToQuantityMap() {
                let fcmQuantityMap: Map<string, number> = new Map();
                let purchasedQuantityPromise: Array<Promise<[string, number]>> = [];
                for (let i = awaitingPickup.length - 1; i == 0; i--) {
                    let remainder = 0;
                    let quantityPurchased = 0;
                    let resolveTuple: [string, number];
                    let anyToken;
                    let fcmToken: string;

                    anyToken = await getFcmToken(awaitingPickup[i])

                    if (anyToken) {
                        fcmToken = anyToken
                    }

                    await db.collection("Shops")
                        .doc(<string>shopId)
                        .collection("barcodeInfo")
                        .doc(awaitingPickup[i])
                        .collection("items")
                        .doc(itemId).get().then(function (snapshot) {
                            quantityPurchased = snapshot?.data()?.quantityPurchased;
                            remainder = quantityPurchased - deficit;
                        })

                    if (remainder < 0) {
                        purchasedQuantityPromise.push(new Promise((resolve => {
                            resolveTuple = [fcmToken, quantityPurchased]
                            resolve(resolveTuple)
                        })))
                        deficit -= quantityPurchased;
                    } else {
                        purchasedQuantityPromise.push(new Promise((resolve => {
                            resolveTuple = [fcmToken, deficit]
                            resolve(resolveTuple)
                        })))
                        deficit -= quantityPurchased;
                        break;
                    }
                }

                await Promise.all(purchasedQuantityPromise).then((results) => {

                    for (let i = 0; i < purchasedQuantityPromise.length; i++) {
                        purchasedQuantityPromise[i].then((promise) => {
                            fcmQuantityMap.set(promise[0], promise[1])
                        })
                    }

                })
                return fcmQuantityMap
            }


            await pushToQuantityMap().then((map) => {
                return sendMessage(map)
            });


            async function getFcmToken(uid: string) {
                let returnedToken = null;
                const docRef = db.collection("users").doc(uid);
                await docRef.get().then(function (snapshot) {
                    returnedToken = snapshot?.data()?.fcmToken;
                })
                return returnedToken;
            }


            async function sendMessage(fcmMap: Map<string, number>) {
                if (item) {
                    fcmMap.forEach((value, key) => {
                        if(!value){
                            console.log("value undefined " + value.toString())
                        }else{
                            console.log("value defined" + value.toString())
                        }
                        let dataPayload = {
                            'id': itemId,
                            'itemQuantity': item.itemQuantity,
                            'itemsReserved': item.itemsReserved,
                            'name': item.name,
                            'newPrice': item.newPrice,
                            'oldPrice': item.oldPrice,
                            'quantityToRemove': value.toString(),
                            'notificationType': 'quantityZero'
                        }

                        const payload: admin.messaging.MessagingPayload = {
                            notification: {
                                title: item.name + ' No Longer Available!',
                                body: `Despite the best efforts of the shop owner, someone else has picked up an item you purchased, we will refund you for this item`,
                                click_action: 'FLUTTER_NOTIFICATION_CLICK'
                            },
                            data: dataPayload
                        };
                        console.log(key + payload.notification + value.toString())
                        return fcm.sendToDevice(key, payload);
                    })
                }
            }
        }
        return "whoops";
    });
