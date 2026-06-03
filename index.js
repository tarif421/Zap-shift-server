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

const generateTrackingId = () => {
  const prefix = "TRK";
  const timestamp = Date.now().toString().slice(-6); // Last 6 digits of current time
  const randomStr = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `${prefix}-${timestamp}-${randomStr}`;
};

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

    // parcel api
    app.get("/parcels", async (req, res) => {
      const query = {};
      // get parcel by sender email
      const { email } = req.query;
      if (email) {
        query.senderEmail = email;
      }
      //  sort
      const options = { sort: { createdAt: -1 } };
      const cursor = parcelCollection.find(query, options);
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

    app.delete("/parcels/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await parcelCollection.deleteOne(query);
      res.send(result);
    });
    //  payment related apis
    app.post("/create-cheackout-seassion", async (req, res) => {
      const paymentInfo = req.body;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: 'usd',
              unit_amount: 1500,
              product_data: {
                name: paymentInfo.parcelInfo.parcelName
              }
            },
        
            quantity: 1,
          },
        ],
            customer_email: paymentInfo.senderEmail,
        mode: "payment",
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success`,
      });
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
