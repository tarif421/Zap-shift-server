const dns = require("dns");
dns.setServers(["8.8.8.8", "8.8.4.4"]);

const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const port = process.env.PORT || 3000;

const admin = require("firebase-admin");

const serviceAccount = require("./zap-shift-cbd1a-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

//  tracking id
const crypto = require("crypto");
const { log } = require("console");

function generateTrackingId() {
  const randomSet = crypto.randomBytes(3).toString("hex").toUpperCase();
  const currentYear = new Date().getFullYear(); // 2026
  return `ZAP-${currentYear}-${randomSet}`;
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9aos02c.mongodb.net/?appName=Cluster0`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  // console.log("headers in the middleware ", req.headers.authorization);
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ messag: "unathorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("Decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.error("Firebase Auth Error:", error.message);

    return res.status(401).send({ message: "forbidden access" });
  }
};

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("zap_shift_db");
    const parcelCollection = db.collection("parcels");
    const paymentCollection = db.collection("payments");
    const userCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    const trackingCollection = db.collection("trackings");

    // middleware admin before allowing admin activity
    //  must be used after verigyfbtoken
    const verifyAdminToken = async (req, res, next) => {
      const email = req.decoded_email;
      const query = { email };
      const user = await userCollection.findOne(query);

      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "forbiddem access" });
      }
      next();
    };
    // tracking
    const logTracking = async (trackingId, status) => {
      try {
        const log = {
          trackingId,
          status,
          details: status.split("_").join(" "),
          createdAt: new Date(),
        };

        const result = await trackingCollection.insertOne(log);
        return result;
      } catch (error) {
        console.error("Tracking log error:", error);
      }
    };

    //  user related apis
    app.get("/users", async (req, res) => {
      // search
      const searchText = req.query.searchText;
      const query = {};
      if (searchText) {
        // query.displayName = { $regex: searchText, $options: "i" };
        // alternative
        query.$or = [
          { displayName: { $regex: searchText, $options: "i" } },
          { email: { $regex: searchText, $options: "i" } },
        ];
      }
      //
      const cursor = userCollection
        .find(query)
        .sort({ createdAt: -1 })
        .limit(5);
      const result = await cursor.toArray();
      res.send(result);
    });
    // app.get("/user/:id", async (req, res) => {});
    app.get("/users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await userCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });
    app.post("/users", async (req, res) => {
      const user = req.body;

      user.role = "user";
      user.createdAt = new Date();
      const email = user.email;
      const userExists = await userCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await userCollection.insertOne(user);
      res.send(result);
    });
    // parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};
      const { email, deliveryStatus } = req.query;
      // get parcel by sender email
      // const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      }
      //  sort
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/parcels/rider", async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};

      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      } else {
        query.deliveryStatus = { $nin: ["parcel_delivered", "rejected"] };
      }

      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.get("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await parcelCollection.findOne(query);
      res.send(result);
    });
    app.post("/parcel", async (req, res) => {
      const parcel = req.body;
      // parcels created time
      parcel.createdAt = new Date();
      const result = await parcelCollection.insertOne(parcel);
      res.send(result);
    });

    // Admin Assign Rider Route
    app.patch("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const { riderId, riderName, riderEmail, trackingId } = req.body;

      const query = { _id: new ObjectId(id) };

      const parcel = await parcelCollection.findOne(query);
      const activeTrackingId = trackingId || parcel?.trackingId;

      const updatedDoc = {
        $set: {
          deliveryStatus: "driver_assign",
          riderId: riderId,
          riderName: riderName,
          riderEmail: riderEmail,
        },
      };
      const result = await parcelCollection.updateOne(query, updatedDoc);

      // rider status update
      const riderQuery = { _id: new ObjectId(riderId) };
      const riderUpdatedDoc = {
        $set: {
          workStatus: "in_delivery",
        },
      };
      await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);

      // tracking log saived
      if (activeTrackingId) {
        await logTracking(activeTrackingId, "driver_assign");
      }

      res.send(result);
    });
    // app.patch("/parcels/:id/status", async (req, res) => {
    //   const { deliveryStatus, riderId } = req.body;
    //   const query = { _id: new ObjectId(req.params.id) };
    //   const updateDoc = {
    //     $set: {
    //       deliveryStatus: deliveryStatus,
    //     },
    //   };
    //   if (deliveryStatus === "parcel_delivered") {
    //     // update rider information
    //     const riderQuery = { _id: new ObjectId(riderId) };
    //     const riderUpdatedDoc = {
    //       $set: {
    //         workStatus: "available",
    //       },
    //     };
    //     const riderResult = await ridersCollection.updateOne(
    //       riderQuery,
    //       riderUpdatedDoc,
    //     );
    //   }

    //   const result = await parcelCollection.updateOne(query, updateDoc);
    //   res.send(result);
    // });

    //  Rider Parcels API
    app.get("/parcels/rider", verifyFBToken, async (req, res) => {
      const { riderEmail, deliveryStatus } = req.query;
      const query = {};

      if (riderEmail) {
        query.riderEmail = riderEmail;
      }

      if (deliveryStatus) {
        query.deliveryStatus = deliveryStatus;
      } else {
        query.deliveryStatus = { $nin: ["parcel_delivered", "rejected"] };
      }

      const cursor = parcelCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });

    // Rider Status Update API
    app.patch("/parcels/:id/status", verifyFBToken, async (req, res) => {
      try {
        const { deliveryStatus, riderId, trackingId } = req.body;
        const query = { _id: new ObjectId(req.params.id) };

        const parcel = await parcelCollection.findOne(query);
        if (!parcel) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        const activeTrackingId = trackingId || parcel.trackingId;

        const updateDoc = {
          $set: {
            deliveryStatus: deliveryStatus,
          },
        };
        const result = await parcelCollection.updateOne(query, updateDoc);

        if (deliveryStatus === "parcel_delivered" && riderId) {
          try {
            await ridersCollection.updateOne(
              { _id: new ObjectId(riderId) },
              { $set: { workStatus: "available" } },
            );
          } catch (err) {
            console.error("Rider status update failed:", err.message);
          }
        }

        // `trackings`
        if (activeTrackingId) {
          await logTracking(activeTrackingId, deliveryStatus);
        }

        res.send(result);
      } catch (error) {
        console.error("Error updating status:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });
    // app.patch("/parcels/:id/status", verifyFBToken, async (req, res) => {
    //   const { deliveryStatus, riderId, trackingId } = req.body;
    //   const query = { _id: new ObjectId(req.params.id) };

    //   const updateDoc = {
    //     $set: {
    //       deliveryStatus: deliveryStatus,
    //     },
    //   };

    //   // riderId check
    //   if (deliveryStatus === "parcel_delivered" && riderId) {
    //     try {
    //       const riderQuery = { _id: new ObjectId(riderId) };
    //       const riderUpdatedDoc = {
    //         $set: {
    //           workStatus: "available",
    //         },
    //       };
    //       await ridersCollection.updateOne(riderQuery, riderUpdatedDoc);
    //     } catch (err) {
    //       console.error("Failed to update rider status:", err.message);
    //     }
    //   }

    //   const result = await parcelCollection.updateOne(query, updateDoc);
    //   // log Tracking
    //   log(trackingId, deliveryStatus)
    //   res.send(result);
    // });

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });
    //  payment related apis
    app.post("/create-cheackout-seassion", async (req, res) => {
      const paymentInfo = req.body;
      const amount = parseInt(paymentInfo.cost) * 100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.parcelName,
              },
            },

            quantity: 1,
          },
        ],
        customer_email: paymentInfo.senderEmail,
        mode: "payment",
        metadata: {
          parcelId: paymentInfo.parcelId,
          parcelName: paymentInfo.parcelName,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      // console.log(session)
      res.send({ url: session.url });
    });
    app.patch("/payment-success", async (req, res) => {
      const sessionId = req.query.session_id;
      // console.log(" session id", sessionId);
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      // console.log('session retrieve', session)

      //  fix duplicate
      const transactionId = session.payment_intent;
      const query = { transactionId: transactionId };
      const paymentExist = await paymentCollection.findOne(query);
      if (paymentExist) {
        return res.send({
          message: "already exists",
          transactionId,
          trackingId: paymentExist.trackingId,
        });
      }

      //
      const trackingId = generateTrackingId();

      if (session.payment_status === "paid") {
        const id = session.metadata.parcelId;
        const query = { _id: new ObjectId(id) };
        const update = {
          $set: {
            paymentStatus: "paid",
            deliveryStatus: "pending-pickup",
            trackingId: trackingId,
          },
        };
        const result = await parcelCollection.updateOne(query, update);

        const payment = {
          amount: session.amount_total / 100,
          currency: session.currency,
          customerEmail: session.customer_email,
          parcelId: session.metadata.parcelId,
          parcelName: session.metadata.parcelName,
          transactionId: session.payment_intent,
          paymentStatus: session.payment_status,
          paymentDate: new Date(),
          trackingId: trackingId,
        };

        if (session.payment_status === "paid") {
          const resultPayment = await paymentCollection.insertOne(payment);

          logTracking(trackingId, "pending-pickup");
          return res.send({
            success: true,
            modifyParcel: result,
            trackingId: trackingId,
            paymentInfo: resultPayment,
            transactionId: session.payment_intent,
          });
        }
      }
      return res.send({ success: false, message: "Payment not verified" });
    });

    //  payment history by email
    app.get("/payments", async (req, res) => {
      const email = req.query.email;
      const query = {};
      if (email) {
        query.customerEmail = email;
      }
      const cursor = paymentCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    //  riders related api
    app.get("/riders", async (req, res) => {
      const { status, districts, workStatus } = req.query;
      const query = {};
      if (status) {
        query.status = status;
      }
      if (districts) {
        query.districts = districts;
      }
      if (workStatus) {
        query.workStatus = workStatus;
      }
      const cursor = ridersCollection.find(query);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.post("/riders", async (req, res) => {
      const rider = req.body;
      const email = rider.email;

      const riderExists = await ridersCollection.findOne({ email });

      if (riderExists) {
        return res.send({ message: "already applied" });
      }

      rider.status = "pending";
      rider.createdAt = new Date();

      const result = await ridersCollection.insertOne(rider);
      res.send(result);
    });
    app.patch(
      "/riders/:id/role",
      verifyFBToken,
      verifyAdminToken,

      async (req, res) => {
        const status = req.body.status;
        const id = req.params.id;
        const query = { _id: new ObjectId(id) };
        const updateDoc = {
          $set: {
            status: status,
            workStatus: "available",
          },
        };
        const result = await ridersCollection.updateOne(query, updateDoc);

        if (status === "approved") {
          const email = req.body.email;
          const useQuery = { email };
          const updateUser = {
            $set: {
              role: "rider",
            },
          };
          const userResult = await userCollection.updateOne(
            useQuery,
            updateUser,
          );
        }

        res.send(result);
      },
    );
    // Get tracking history by trackingId
    app.get("/trackings/:trackingId", async (req, res) => {
      const { trackingId } = req.params;
      const result = await trackingCollection
        .find({ trackingId })
        .sort({ createdAt: 1 }) 
        .toArray();
      res.send(result);
    });
    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("Zap is Shifting shifting");
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
