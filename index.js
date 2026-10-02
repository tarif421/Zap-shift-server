const express = require("express");
const cors = require("cors");
const app = express();
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);
const crypto = require("crypto");
const admin = require("firebase-admin");

const port = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Safe Firebase Admin Initialization
try {
  if (process.env.FB_SERVICE_KEY) {
    let serviceAccount;

    try {
      serviceAccount = JSON.parse(process.env.FB_SERVICE_KEY);
    } catch {
      const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString("utf8");
      serviceAccount = JSON.parse(decoded);
    }

    if (serviceAccount.private_key) {
      serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, "\n");
    }

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
      });
      console.log("✅ Firebase Admin Initialized Successfully!");
    }
  } else {
    console.error("❌ process.env.FB_SERVICE_KEY was not found!");
  }
} catch (error) {
  console.error("Firebase Admin Initialization Error:", error.message);
}

// Tracking ID Generator
function generateTrackingId() {
  const randomSet = crypto.randomBytes(3).toString("hex").toUpperCase();
  const currentYear = new Date().getFullYear();
  return `ZAP-${currentYear}-${randomSet}`;
}

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.9aos02c.mongodb.net/?appName=Cluster0`;

// MongoClient configuration
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Global Database Collections Setup
const db = client.db("zap_shift_db");
const parcelCollection = db.collection("parcels");
const paymentCollection = db.collection("payments");
const userCollection = db.collection("users");
const ridersCollection = db.collection("riders");
const trackingCollection = db.collection("trackings");

// Firebase Auth Middleware
const verifyFBToken = async (req, res, next) => {
  const token = req.headers.authorization;

  if (!token || !token.startsWith("Bearer ")) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    req.decoded_email = decoded.email;
    next();
  } catch (error) {
    console.error("Firebase Auth Error:", error.message);
    return res.status(401).send({ message: "unauthorized access" });
  }
};

// Admin Verification Middleware
const verifyAdminToken = async (req, res, next) => {
  try {
    const email = req.decoded_email;
    if (!email) {
      return res.status(403).send({ message: "forbidden access" });
    }

    const query = { email: { $regex: new RegExp(`^${email}$`, "i") } };
    const user = await userCollection.findOne(query);

    if (!user || user.role !== "admin") {
      return res.status(403).send({ message: "forbidden access" });
    }
    next();
  } catch (error) {
    console.error("Verify Admin Error:", error);
    res.status(500).send({ message: "Internal server error" });
  }
};

// Helper: Tracking Logger
const logTracking = async (trackingId, status) => {
  try {
    const log = {
      trackingId,
      status,
      details: status.split("_").join(" "),
      createdAt: new Date(),
    };
    return await trackingCollection.insertOne(log);
  } catch (error) {
    console.error("Tracking log error:", error);
  }
};

// =================== ALL ROUTES ===================

// Root API
app.get("/", (req, res) => {
  res.send("Zap is Shifting shifting");
});

// User Related APIs
app.get("/users", async (req, res) => {
  try {
    const searchText = req.query.searchText;
    const query = {};
    if (searchText) {
      query.$or = [
        { displayName: { $regex: searchText,$options: "i" } },
        { email: { $regex: searchText,$options: "i" } },
      ];
    }
    const cursor = userCollection.find(query).sort({ createdAt: -1 }).limit(5);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Get User Role API
app.get("/users/:email/role", async (req, res) => {
  try {
    const email = req.params.email;
    const query = { email: { $regex: new RegExp(`^${email}$`, "i") } };
    const user = await userCollection.findOne(query);
    res.send({ role: user?.role || "user" });
  } catch (error) {
    console.error("Error getting user role:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.post("/users", async (req, res) => {
  try {
    const user = req.body;
    user.role = "user";
    user.createdAt = new Date();
    const email = user.email;
    const userExists = await userCollection.findOne({
      email: { $regex: new RegExp(`^${email}$`, "i") },
    });

    if (userExists) {
      return res.send({ message: "user exists" });
    }

    const result = await userCollection.insertOne(user);
    res.send(result);
  } catch (error) {
    console.error("Error saving user:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Parcel APIs
app.get("/parcels", async (req, res) => {
  try {
    const query = {};
    const { email, deliveryStatus } = req.query;
    if (email) query.senderEmail = email;
    if (deliveryStatus) query.deliveryStatus = deliveryStatus;

    const options = { sort: { createdAt: -1 } };
    const cursor = parcelCollection.find(query, options);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching parcels:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.get("/parcels/rider", verifyFBToken, async (req, res) => {
  try {
    const { riderEmail, deliveryStatus } = req.query;
    const query = {};

    if (riderEmail) query.riderEmail = riderEmail;
    if (deliveryStatus) {
      query.deliveryStatus = deliveryStatus;
    } else {
      query.deliveryStatus = { $nin: ["parcel_delivered", "rejected"] };
    }

    const cursor = parcelCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching rider parcels:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.get("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await parcelCollection.findOne(query);
    res.send(result);
  } catch (error) {
    console.error("Error fetching parcel:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.post("/parcel", async (req, res) => {
  try {
    const parcel = req.body;
    parcel.createdAt = new Date();
    const result = await parcelCollection.insertOne(parcel);
    res.send(result);
  } catch (error) {
    console.error("Error creating parcel:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Admin Assign Rider
app.patch("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const { riderId, riderName, riderEmail, trackingId } = req.body;

    const query = { _id: new ObjectId(id) };
    const parcel = await parcelCollection.findOne(query);
    const activeTrackingId = trackingId || parcel?.trackingId;

    const updatedDoc = {
      $set: {
        deliveryStatus: "driver_assign",
        riderId,
        riderName,
        riderEmail,
      },
    };
    const result = await parcelCollection.updateOne(query, updatedDoc);

    const riderQuery = { _id: new ObjectId(riderId) };
    await ridersCollection.updateOne(riderQuery, {
      $set: { workStatus: "in_delivery" },
    });

    if (activeTrackingId) {
      await logTracking(activeTrackingId, "driver_assign");
    }

    res.send(result);
  } catch (error) {
    console.error("Error assigning rider:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Rider Status Update
app.patch("/parcels/:id/status", verifyFBToken, async (req, res) => {
  try {
    const { deliveryStatus, riderId, trackingId } = req.body;
    const query = { _id: new ObjectId(req.params.id) };

    const parcel = await parcelCollection.findOne(query);
    if (!parcel) {
      return res.status(404).send({ message: "Parcel not found" });
    }

    const activeTrackingId = trackingId || parcel.trackingId;

    const updateDoc = { $set: { deliveryStatus } };
    const result = await parcelCollection.updateOne(query, updateDoc);

    if (deliveryStatus === "parcel_delivered" && riderId) {
      try {
        await ridersCollection.updateOne(
          { _id: new ObjectId(riderId) },
          { $set: { workStatus: "available" } }
        );
      } catch (err) {
        console.error("Rider status update failed:", err.message);
      }
    }

    if (activeTrackingId) {
      await logTracking(activeTrackingId, deliveryStatus);
    }

    res.send(result);
  } catch (error) {
    console.error("Error updating status:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.delete("/parcels/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };
    const result = await parcelCollection.deleteOne(query);
    res.send(result);
  } catch (error) {
    console.error("Error deleting parcel:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Payment APIs
app.post("/create-cheackout-seassion", async (req, res) => {
  try {
    const paymentInfo = req.body;
    const amount = parseInt(paymentInfo.cost) * 100;
    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amount,
            product_data: { name: paymentInfo.parcelName },
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

    res.send({ url: session.url });
  } catch (error) {
    console.error("Error creating checkout session:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.patch("/payment-success", async (req, res) => {
  try {
    const sessionId = req.query.session_id;
    const session = await stripe.checkout.sessions.retrieve(sessionId);

    const transactionId = session.payment_intent;
    const query = { transactionId };
    const paymentExist = await paymentCollection.findOne(query);

    if (paymentExist) {
      return res.send({
        message: "already exists",
        transactionId,
        trackingId: paymentExist.trackingId,
      });
    }

    const trackingId = generateTrackingId();

    if (session.payment_status === "paid") {
      const id = session.metadata.parcelId;
      const update = {
        $set: {
          paymentStatus: "paid",
          deliveryStatus: "pending-pickup",
          trackingId,
        },
      };
      const result = await parcelCollection.updateOne({ _id: new ObjectId(id) }, update);

      const payment = {
        amount: session.amount_total / 100,
        currency: session.currency,
        customerEmail: session.customer_email,
        parcelId: session.metadata.parcelId,
        parcelName: session.metadata.parcelName,
        transactionId: session.payment_intent,
        paymentStatus: session.payment_status,
        paymentDate: new Date(),
        trackingId,
      };

      const resultPayment = await paymentCollection.insertOne(payment);
      logTracking(trackingId, "pending-pickup");

      return res.send({
        success: true,
        modifyParcel: result,
        trackingId,
        paymentInfo: resultPayment,
        transactionId: session.payment_intent,
      });
    }

    return res.send({ success: false, message: "Payment not verified" });
  } catch (error) {
    console.error("Error processing payment success:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.get("/payments", async (req, res) => {
  try {
    const email = req.query.email;
    const query = {};
    if (email) query.customerEmail = email;

    const cursor = paymentCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching payments:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Riders APIs
app.get("/riders", async (req, res) => {
  try {
    const { status, districts, workStatus } = req.query;
    const query = {};
    if (status) query.status = status;
    if (districts) query.districts = districts;
    if (workStatus) query.workStatus = workStatus;

    const cursor = ridersCollection.find(query);
    const result = await cursor.toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching riders:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.post("/riders", async (req, res) => {
  try {
    const rider = req.body;
    const email = rider.email;
    const riderExists = await ridersCollection.findOne({
      email: { $regex: new RegExp(`^${email}$`, "i") },
    });

    if (riderExists) {
      return res.send({ message: "already applied" });
    }

    rider.status = "pending";
    rider.createdAt = new Date();

    const result = await ridersCollection.insertOne(rider);
    res.send(result);
  } catch (error) {
    console.error("Error creating rider:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

app.patch("/riders/:id/role", verifyFBToken, verifyAdminToken, async (req, res) => {
  try {
    const status = req.body.status;
    const id = req.params.id;
    const query = { _id: new ObjectId(id) };

    const updateDoc = {
      $set: { status, workStatus: "available" },
    };
    const result = await ridersCollection.updateOne(query, updateDoc);

    if (status === "approved") {
      const email = req.body.email;
      await userCollection.updateOne(
        { email: { $regex: new RegExp(`^${email}$`, "i") } },
        { $set: { role: "rider" } }
      );
    }

    res.send(result);
  } catch (error) {
    console.error("Error updating rider role:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Tracking API
app.get("/trackings/:trackingId", async (req, res) => {
  try {
    const { trackingId } = req.params;
    const result = await trackingCollection
      .find({ trackingId })
      .sort({ createdAt: 1 })
      .toArray();
    res.send(result);
  } catch (error) {
    console.error("Error fetching tracking:", error);
    res.status(500).send({ message: "Internal server error" });
  }
});

// Connect Database
async function connectDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB!");
  } catch (err) {
    console.error("MongoDB Connection Error:", err);
  }
}
connectDB();

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});