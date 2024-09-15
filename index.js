require("dotenv").config();
const express = require("express");
const app = express();
const jwt = require("jsonwebtoken");
const cors = require("cors");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const bodyParser = require("body-parser"); // Needed to process Stripe webhooks
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; // Add webhook secret

// Middleware and CORS
app.use(cors());
app.use(bodyParser.raw({ type: "application/json" })); // For Stripe webhook handling

// Webhook route before express.json()

// Use express.json() for other routes after the webhook
const port = process.env.PORT || 5000;

const uri = process.env.DATABASE_URL;

// MongoDB connection and routes setup
async function run() {
  try {
    const client = new MongoClient(uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    });

    await client.connect();

    const productsDb = client.db("productsDb");
    const userDB = client.db("userDB");
    const ordersDB = client.db("ordersDB"); // New orders database

    const productsCollection = productsDb.collection("productsCollection");
    const usersCollection = userDB.collection("usersCollection");
    const ordersCollection = ordersDB.collection("ordersCollection"); // Assign ordersCollection here

    // Now that MongoDB is connected, set up other routes

    app.post("/webhook", async (request, response) => {
      const sig = request.headers["stripe-signature"];
      let event;

      try {
        // Verify the event with Stripe signature
        event = stripe.webhooks.constructEvent(
          request.body,
          sig,
          endpointSecret
        );
      } catch (err) {
        console.error("Webhook signature verification failed:", err.message);
        return response.status(400).send(`Webhook Error: ${err.message}`);
      }

      // Handle the event
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object;

          // Prepare order data
          const newOrder = {
            email: session.customer_email,
            items:
              session.display_items ||
              session.line_items.map((item) => ({
                description: item.description,
                amount: item.amount_total,
                quantity: item.quantity,
              })),
            amount_total: session.amount_total,
            payment_status: session.payment_status,
            created_at: new Date(),
          };

          try {
            // Save the order to MongoDB
            await ordersCollection.insertOne(newOrder);
            console.log("Order successfully created in the database.");
          } catch (error) {
            console.error("Error saving order to the database:", error);
            return response
              .status(500)
              .send("Error creating order in database.");
          }
          break;
        }

        default:
          console.log(`Unhandled event type: ${event.type}`);
      }

      // Return a 200 response to acknowledge receipt of the event
      response.json({ received: true });
    });
    app.use(express.json());
    // Product routes
    app.get("/products", async (req, res) => {
      const productData = productsCollection.find();
      const result = await productData.toArray();
      res.send(result);
    });

    app.post("/products", verifyToken, async (req, res) => {
      const productData = req.body;
      const result = await productsCollection.insertOne(productData);
      res.send(result);
    });

    app.get("/products/:id", async (req, res) => {
      const id = req.params.id;
      const productsData = await productsCollection.findOne({
        _id: new ObjectId(id),
      });
      res.send(productsData);
    });

    app.patch("/products/:id", verifyToken, async (req, res) => {
      const id = req.params.id;
      const updatedData = req.body;
      const result = await productsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: updatedData }
      );
      res.send(result);
    });

    app.delete("/products/:id", async (req, res) => {
      const id = req.params.id;
      const result = await productsCollection.deleteOne({
        _id: new ObjectId(id),
      });
      res.send(result);
    });

    // User routes
    app.post("/users", async (req, res) => {
      const user = req.body;
      const token = createToken(user);

      const userExists = await usersCollection.findOne({ email: user?.email });
      if (userExists?._id) {
        return res.json({ message: "Login successful", token });
      }
      await usersCollection.insertOne(user);
      res.json({ token });
    });

    app.get("/users", async (req, res) => {
      const usersData = usersCollection.find();
      const result = await usersData.toArray();
      res.send(result);
    });

    app.get("/users/:email", async (req, res) => {
      const email = req.params.email;
      const result = await usersCollection.findOne({ email });
      res.send(result);
    });

    app.patch("/users/:email", async (req, res) => {
      const email = req.params.email;
      const userData = req.body;
      const result = await usersCollection.updateOne(
        { email },
        { $set: userData },
        { upsert: true }
      );
      res.send(result);
    });

    // Payment route...
    app.post("/checkout", async (req, res) => {
      const { cart, email } = req.body;

      try {
        const session = await stripe.checkout.sessions.create({
          payment_method_types: ["card"],
          customer_email: email,
          line_items: cart.map((item) => ({
            price_data: {
              currency: "usd",
              product_data: {
                name: item.title,
              },
              unit_amount: Math.round(Number(item.price) * 100),
            },
            quantity: item.quantity,
          })),
          mode: "payment",
          success_url: "https://your-success-url.com",
          cancel_url: "https://your-cancel-url.com",
        });

        res.json({ id: session.id });
      } catch (error) {
        res.status(500).json({ error: "Unable to create checkout session." });
      }
    });

    // Start server after MongoDB connects
    app.listen(port, () => {
      console.log(`Server is running on port ${port}`);
    });

    console.log("Successfully connected to MongoDB!");
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
  }
}

// Run the MongoDB connection and server start function
run().catch(console.dir);

// Helper function to create JWT token
const createToken = (user) => {
  const token = jwt.sign(
    { email: user.email },
    process.env.JWT_SECRET || "secret",
    { expiresIn: "7d" }
  );
  return token;
};

// Middleware for JWT verification
const verifyToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) {
    return res.status(403).send("Authorization token is missing.");
  }

  try {
    const verify = jwt.verify(token, process.env.JWT_SECRET || "secret");
    if (!verify?.email) {
      return res.status(401).send("Unauthorized.");
    }
    req.user = verify.email;
    next();
  } catch (error) {
    return res.status(401).send("Invalid token.");
  }
};
